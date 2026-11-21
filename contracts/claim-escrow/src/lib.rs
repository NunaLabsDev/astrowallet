#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    xdr::ToXdr, Address, Bytes, BytesN, Env,
};

// Conservative 3s/ledger lower bound prevents premature archival if ledger close times speed up.
const MIN_SECS_PER_LEDGER: u64 = 3;
const DAY_IN_LEDGERS_CONSERVATIVE: u32 = 28_800;
const CLAIM_TTL_MIN_LEDGERS: u32 = DAY_IN_LEDGERS_CONSERVATIVE * 14;
const CLAIM_TTL_BUFFER_LEDGERS: u32 = DAY_IN_LEDGERS_CONSERVATIVE * 14;
const CLAIM_TTL_MAX_LEDGERS: u32 = DAY_IN_LEDGERS_CONSERVATIVE * 60;
const TERMINAL_TTL_LEDGERS: u32 = DAY_IN_LEDGERS_CONSERVATIVE * 7;
const INSTANCE_TTL_THRESHOLD: u32 = DAY_IN_LEDGERS_CONSERVATIVE * 7;
const INSTANCE_TTL_EXTEND_TO: u32 = DAY_IN_LEDGERS_CONSERVATIVE * 30;
const MAX_CLAIM_DURATION_SECS: u64 = 30 * 86_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ClaimError {
    AlreadyExists = 1,
    NotFound = 2,
    InvalidAmount = 3,
    InvalidExpiry = 4,
    NotOpen = 5,
    Expired = 6,
    NotExpiredYet = 7,
    InvalidAddress = 8,
    DurationTooLong = 9,
    InvalidClaimKey = 10,
    UnsupportedTokenBehavior = 11,
    NotCancellable = 12,
    DepositsPaused = 13,
    AlreadyInitialized = 14,
    NotInitialized = 15,
    InsufficientExcess = 16,
    Overflow = 17,
    Reentrancy = 18,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ClaimStatus {
    Open = 0,
    Claimed = 1,
    Refunded = 2,
    Cancelled = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Claim(BytesN<32>),
    Guardian,
    DepositsPaused,
    EscrowedBalance(Address),
    ReentrancyLock,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimDeposit {
    pub sender: Address,
    pub token: Address,
    pub amount: i128,
    pub claim_pubkey: BytesN<32>,
    pub expires_at: u64,
    pub cancellable: bool,
    pub status: ClaimStatus,
}

fn compute_claim_ttl_ledgers(now: u64, expires_at: u64) -> u32 {
    let duration_secs = expires_at.saturating_sub(now);
    let duration_ledgers = (duration_secs / MIN_SECS_PER_LEDGER).min(u32::MAX as u64) as u32;
    duration_ledgers
        .saturating_add(CLAIM_TTL_BUFFER_LEDGERS)
        .clamp(CLAIM_TTL_MIN_LEDGERS, CLAIM_TTL_MAX_LEDGERS)
}

fn build_claim_sign_payload(env: &Env, claim_id: &BytesN<32>, recipient: &Address) -> Bytes {
    let mut payload = Bytes::from_slice(env, b"AW_CLAIM_V2:");
    payload.append(&env.current_contract_address().to_xdr(env));
    payload.append(&claim_id.clone().into());
    payload.append(&recipient.to_xdr(env));
    payload
}

fn acquire_lock(env: &Env) -> Result<(), ClaimError> {
    if env.storage().temporary().has(&DataKey::ReentrancyLock) {
        return Err(ClaimError::Reentrancy);
    }
    env.storage()
        .temporary()
        .set(&DataKey::ReentrancyLock, &true);
    Ok(())
}

fn release_lock(env: &Env) {
    env.storage().temporary().remove(&DataKey::ReentrancyLock);
}

fn increase_escrowed_balance(env: &Env, token: &Address, amount: i128) {
    let key = DataKey::EscrowedBalance(token.clone());
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let next = match current.checked_add(amount) {
        Some(v) => v,
        None => panic_with_error!(env, ClaimError::Overflow),
    };
    env.storage().persistent().set(&key, &next);
    env.storage()
        .persistent()
        .extend_ttl(&key, CLAIM_TTL_MAX_LEDGERS / 2, CLAIM_TTL_MAX_LEDGERS);
}

fn decrease_escrowed_balance(env: &Env, token: &Address, amount: i128) {
    let key = DataKey::EscrowedBalance(token.clone());
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let next = match current.checked_sub(amount) {
        Some(v) => v,
        None => panic_with_error!(env, ClaimError::Overflow),
    };
    env.storage().persistent().set(&key, &next);
    env.storage()
        .persistent()
        .extend_ttl(&key, CLAIM_TTL_MAX_LEDGERS / 2, CLAIM_TTL_MAX_LEDGERS);
}

fn write_terminal_deposit(env: &Env, key: &DataKey, deposit: &ClaimDeposit) {
    env.storage().persistent().set(key, deposit);
    env.storage()
        .persistent()
        .extend_ttl(key, TERMINAL_TTL_LEDGERS / 2, TERMINAL_TTL_LEDGERS);
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

#[contract]
pub struct ClaimEscrowContract;

#[contractimpl]
impl ClaimEscrowContract {
    /// Initializes an optional governance guardian (recommended: multisig/timelock)
    /// that can pause *new deposits only* or rescue unrelated excess tokens sent by mistake.
    pub fn init(env: Env, guardian: Address) -> Result<(), ClaimError> {
        if env.storage().instance().has(&DataKey::Guardian) {
            return Err(ClaimError::AlreadyInitialized);
        }
        if guardian == env.current_contract_address() {
            return Err(ClaimError::InvalidAddress);
        }
        guardian.require_auth();
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage()
            .instance()
            .set(&DataKey::DepositsPaused, &false);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        env.events()
            .publish((symbol_short!("escrow"), symbol_short!("init")), guardian);
        Ok(())
    }

    /// Emergency circuit breaker that pauses *new* `create_claim` deposits only.
    /// Existing claims, cancellations, and expired refunds always remain unblocked.
    pub fn set_deposits_paused(env: Env, paused: bool) -> Result<(), ClaimError> {
        let guardian: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .ok_or(ClaimError::NotInitialized)?;
        guardian.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::DepositsPaused, &paused);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        env.events()
            .publish((symbol_short!("escrow"), symbol_short!("paused")), paused);
        Ok(())
    }

    /// Returns whether new deposits are currently paused.
    pub fn is_deposits_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::DepositsPaused)
            .unwrap_or(false)
    }

    /// Returns the total amount of `token` currently locked across open claims.
    pub fn get_escrowed_balance(env: Env, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::EscrowedBalance(token))
            .unwrap_or(0)
    }

    /// Allows the governance guardian to rescue tokens accidentally sent directly to the
    /// contract address outside `create_claim`. Strictly cannot touch `EscrowedBalance`.
    pub fn rescue_excess(
        env: Env,
        token: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), ClaimError> {
        let guardian: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .ok_or(ClaimError::NotInitialized)?;
        guardian.require_auth();
        acquire_lock(&env)?;

        let contract_addr = env.current_contract_address();
        if token == contract_addr || to == contract_addr {
            release_lock(&env);
            return Err(ClaimError::InvalidAddress);
        }
        if amount <= 0 {
            release_lock(&env);
            return Err(ClaimError::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &token);
        let total_balance = token_client.balance(&contract_addr);
        let escrowed = Self::get_escrowed_balance(env.clone(), token.clone());
        let excess = match total_balance.checked_sub(escrowed) {
            Some(v) => v,
            None => {
                release_lock(&env);
                return Err(ClaimError::InsufficientExcess);
            }
        };
        if amount > excess {
            release_lock(&env);
            return Err(ClaimError::InsufficientExcess);
        }

        token_client.transfer(&contract_addr, &to, &amount);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
        release_lock(&env);

        env.events().publish(
            (symbol_short!("escrow"), symbol_short!("rescued"), token),
            (to, amount),
        );
        Ok(())
    }

    /// Locks `amount` of `token` (SAC/SEP-41) into time-locked escrow for a Telegram Claim Link
    /// authorized by an ephemeral Ed25519 public key (`claim_pubkey`).
    #[allow(clippy::too_many_arguments)]
    pub fn create_claim(
        env: Env,
        claim_id: BytesN<32>,
        sender: Address,
        token: Address,
        amount: i128,
        claim_pubkey: BytesN<32>,
        expires_at: u64,
        cancellable: bool,
    ) -> Result<(), ClaimError> {
        sender.require_auth();
        if Self::is_deposits_paused(env.clone()) {
            return Err(ClaimError::DepositsPaused);
        }
        acquire_lock(&env)?;

        let contract_addr = env.current_contract_address();
        if sender == contract_addr || token == contract_addr {
            release_lock(&env);
            return Err(ClaimError::InvalidAddress);
        }
        if claim_pubkey == BytesN::from_array(&env, &[0u8; 32]) {
            release_lock(&env);
            return Err(ClaimError::InvalidClaimKey);
        }
        if amount <= 0 {
            release_lock(&env);
            return Err(ClaimError::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if expires_at <= now {
            release_lock(&env);
            return Err(ClaimError::InvalidExpiry);
        }
        if expires_at - now > MAX_CLAIM_DURATION_SECS {
            release_lock(&env);
            return Err(ClaimError::DurationTooLong);
        }

        let key = DataKey::Claim(claim_id.clone());
        if env.storage().persistent().has(&key) {
            release_lock(&env);
            return Err(ClaimError::AlreadyExists);
        }

        // Verify exact balance delta so fee-on-transfer / rebasing tokens cannot make escrow insolvent.
        let token_client = token::Client::new(&env, &token);
        let bal_before = token_client.balance(&contract_addr);
        token_client.transfer(&sender, &contract_addr, &amount);
        let bal_after = token_client.balance(&contract_addr);
        let received = match bal_after.checked_sub(bal_before) {
            Some(v) => v,
            None => {
                release_lock(&env);
                return Err(ClaimError::UnsupportedTokenBehavior);
            }
        };
        if received != amount {
            release_lock(&env);
            return Err(ClaimError::UnsupportedTokenBehavior);
        }

        // Re-verify key absence after external transfer call to prevent state overwrite.
        if env.storage().persistent().has(&key) {
            release_lock(&env);
            return Err(ClaimError::AlreadyExists);
        }

        let deposit = ClaimDeposit {
            sender: sender.clone(),
            token: token.clone(),
            amount,
            claim_pubkey: claim_pubkey.clone(),
            expires_at,
            cancellable,
            status: ClaimStatus::Open,
        };

        increase_escrowed_balance(&env, &token, amount);

        let ttl_ledgers = compute_claim_ttl_ledgers(now, expires_at);
        env.storage().persistent().set(&key, &deposit);
        env.storage()
            .persistent()
            .extend_ttl(&key, ttl_ledgers / 2, ttl_ledgers);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
        release_lock(&env);

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("created"), claim_id),
            (sender, token, amount, claim_pubkey, expires_at, cancellable),
        );

        Ok(())
    }

    /// Claims an active Telegram Claim Link by presenting a recipient-bound Ed25519 signature
    /// over `"AW_CLAIM_V2:" || contract_xdr || claim_id || recipient_xdr`.
    pub fn claim(
        env: Env,
        claim_id: BytesN<32>,
        recipient: Address,
        signature: BytesN<64>,
    ) -> Result<(), ClaimError> {
        recipient.require_auth();
        acquire_lock(&env)?;

        let contract_addr = env.current_contract_address();
        if recipient == contract_addr {
            release_lock(&env);
            return Err(ClaimError::InvalidAddress);
        }

        let key = DataKey::Claim(claim_id.clone());
        let mut deposit: ClaimDeposit = match env.storage().persistent().get(&key) {
            Some(d) => d,
            None => {
                release_lock(&env);
                return Err(ClaimError::NotFound);
            }
        };

        if deposit.status != ClaimStatus::Open {
            release_lock(&env);
            return Err(ClaimError::NotOpen);
        }
        let now = env.ledger().timestamp();
        if now > deposit.expires_at {
            release_lock(&env);
            return Err(ClaimError::Expired);
        }

        let payload = build_claim_sign_payload(&env, &claim_id, &recipient);
        env.crypto()
            .ed25519_verify(&deposit.claim_pubkey, &payload, &signature);

        // Checks-Effects-Interactions: update state and escrowed balance before external transfer.
        deposit.status = ClaimStatus::Claimed;
        decrease_escrowed_balance(&env, &deposit.token, deposit.amount);
        write_terminal_deposit(&env, &key, &deposit);

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(&contract_addr, &recipient, &deposit.amount);
        release_lock(&env);

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("claimed"), claim_id),
            (deposit.sender, recipient, deposit.token, deposit.amount),
        );

        Ok(())
    }

    /// Returns unclaimed funds to the original sender once `expires_at` has passed.
    pub fn refund_expired(env: Env, claim_id: BytesN<32>) -> Result<(), ClaimError> {
        acquire_lock(&env)?;
        let key = DataKey::Claim(claim_id.clone());
        let mut deposit: ClaimDeposit = match env.storage().persistent().get(&key) {
            Some(d) => d,
            None => {
                release_lock(&env);
                return Err(ClaimError::NotFound);
            }
        };

        if deposit.status != ClaimStatus::Open {
            release_lock(&env);
            return Err(ClaimError::NotOpen);
        }
        if env.ledger().timestamp() <= deposit.expires_at {
            release_lock(&env);
            return Err(ClaimError::NotExpiredYet);
        }

        deposit.status = ClaimStatus::Refunded;
        decrease_escrowed_balance(&env, &deposit.token, deposit.amount);
        write_terminal_deposit(&env, &key, &deposit);

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(
            &env.current_contract_address(),
            &deposit.sender,
            &deposit.amount,
        );
        release_lock(&env);

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("refunded"), claim_id),
            (deposit.sender, deposit.token, deposit.amount),
        );

        Ok(())
    }

    /// Allows the original sender to recover expired funds to an alternate `destination`
    /// (for instance if the original sender account removed its trustline).
    pub fn refund_expired_to(
        env: Env,
        claim_id: BytesN<32>,
        destination: Address,
    ) -> Result<(), ClaimError> {
        let key = DataKey::Claim(claim_id.clone());
        let mut deposit: ClaimDeposit = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ClaimError::NotFound)?;

        deposit.sender.require_auth();
        acquire_lock(&env)?;

        let contract_addr = env.current_contract_address();
        if destination == contract_addr {
            release_lock(&env);
            return Err(ClaimError::InvalidAddress);
        }
        if deposit.status != ClaimStatus::Open {
            release_lock(&env);
            return Err(ClaimError::NotOpen);
        }
        if env.ledger().timestamp() <= deposit.expires_at {
            release_lock(&env);
            return Err(ClaimError::NotExpiredYet);
        }

        deposit.status = ClaimStatus::Refunded;
        decrease_escrowed_balance(&env, &deposit.token, deposit.amount);
        write_terminal_deposit(&env, &key, &deposit);

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(&contract_addr, &destination, &deposit.amount);
        release_lock(&env);

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("refunded"), claim_id),
            (destination, deposit.token, deposit.amount),
        );

        Ok(())
    }

    /// Allows the original sender to cancel an open cancellable claim early and reclaim funds.
    pub fn cancel_claim(env: Env, claim_id: BytesN<32>) -> Result<(), ClaimError> {
        let key = DataKey::Claim(claim_id.clone());
        let mut deposit: ClaimDeposit = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ClaimError::NotFound)?;

        deposit.sender.require_auth();
        acquire_lock(&env)?;

        if deposit.status != ClaimStatus::Open {
            release_lock(&env);
            return Err(ClaimError::NotOpen);
        }
        if !deposit.cancellable {
            release_lock(&env);
            return Err(ClaimError::NotCancellable);
        }

        deposit.status = ClaimStatus::Cancelled;
        decrease_escrowed_balance(&env, &deposit.token, deposit.amount);
        write_terminal_deposit(&env, &key, &deposit);

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(
            &env.current_contract_address(),
            &deposit.sender,
            &deposit.amount,
        );
        release_lock(&env);

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("cancelled"), claim_id),
            (deposit.sender, deposit.token, deposit.amount),
        );

        Ok(())
    }

    /// Permissionless TTL keeper for active claims and their token escrow balance entry.
    pub fn extend_claim_ttl(env: Env, claim_id: BytesN<32>) -> Result<(), ClaimError> {
        let key = DataKey::Claim(claim_id);
        let deposit: ClaimDeposit = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ClaimError::NotFound)?;
        if deposit.status != ClaimStatus::Open {
            return Err(ClaimError::NotOpen);
        }

        let ttl = compute_claim_ttl_ledgers(env.ledger().timestamp(), deposit.expires_at);
        env.storage().persistent().extend_ttl(&key, ttl / 2, ttl);
        env.storage().persistent().extend_ttl(
            &DataKey::EscrowedBalance(deposit.token),
            CLAIM_TTL_MAX_LEDGERS / 2,
            CLAIM_TTL_MAX_LEDGERS,
        );
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
        Ok(())
    }

    /// Inspects the state of a Claim Link deposit.
    pub fn get_claim(env: Env, claim_id: BytesN<32>) -> Option<ClaimDeposit> {
        env.storage().persistent().get(&DataKey::Claim(claim_id))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger},
        token::{StellarAssetClient, TokenClient},
        Env, Map,
    };

    #[contract]
    pub struct FeeOnTransferMockToken;

    #[contractimpl]
    impl FeeOnTransferMockToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let mut balances: Map<Address, i128> = env
                .storage()
                .instance()
                .get(&symbol_short!("BAL"))
                .unwrap_or(Map::new(&env));
            let cur = balances.get(to.clone()).unwrap_or(0);
            balances.set(to, cur + amount);
            env.storage()
                .instance()
                .set(&symbol_short!("BAL"), &balances);
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            let balances: Map<Address, i128> = env
                .storage()
                .instance()
                .get(&symbol_short!("BAL"))
                .unwrap_or(Map::new(&env));
            balances.get(id).unwrap_or(0)
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let mut balances: Map<Address, i128> = env
                .storage()
                .instance()
                .get(&symbol_short!("BAL"))
                .unwrap_or(Map::new(&env));
            let from_bal = balances.get(from.clone()).unwrap_or(0);
            assert!(from_bal >= amount);
            let fee = (amount / 100).max(1);
            let net = amount - fee;
            balances.set(from, from_bal - amount);
            let to_bal = balances.get(to.clone()).unwrap_or(0);
            balances.set(to, to_bal + net);
            env.storage()
                .instance()
                .set(&symbol_short!("BAL"), &balances);
        }
    }

    fn sign_claim_for_recipient(
        env: &Env,
        escrow_id: &Address,
        claim_id: &BytesN<32>,
        recipient: &Address,
        signing_key: &SigningKey,
    ) -> BytesN<64> {
        let mut payload = Bytes::from_slice(env, b"AW_CLAIM_V2:");
        payload.append(&escrow_id.to_xdr(env));
        payload.append(&claim_id.clone().into());
        payload.append(&recipient.to_xdr(env));

        let mut raw = [0u8; 256];
        let len = payload.len() as usize;
        assert!(len <= raw.len());
        payload.copy_into_slice(&mut raw[..len]);

        let sig = signing_key.sign(&raw[..len]);
        BytesN::from_array(env, &sig.to_bytes())
    }

    #[test]
    fn test_create_and_claim_with_valid_ed25519_signature() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(admin);
        let token_id = token_contract.address();
        let sac = StellarAssetClient::new(&env, &token_id);
        let token = TokenClient::new(&env, &token_id);
        sac.mint(&sender, &500);

        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let claim_pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
        let claim_id = BytesN::from_array(&env, &[1u8; 32]);

        client.create_claim(
            &claim_id,
            &sender,
            &token_id,
            &250,
            &claim_pubkey,
            &2_000,
            &true,
        );
        assert_eq!(token.balance(&sender), 250);
        assert_eq!(token.balance(&escrow_id), 250);
        assert_eq!(client.get_escrowed_balance(&token_id), 250);

        let sig = sign_claim_for_recipient(&env, &escrow_id, &claim_id, &recipient, &signing_key);
        client.claim(&claim_id, &recipient, &sig);

        assert_eq!(token.balance(&recipient), 250);
        assert_eq!(token.balance(&escrow_id), 0);
        assert_eq!(client.get_escrowed_balance(&token_id), 0);

        let stored = client.get_claim(&claim_id).expect("claim must exist");
        assert_eq!(stored.status, ClaimStatus::Claimed);

        let double = client.try_claim(&claim_id, &recipient, &sig);
        assert_eq!(double, Err(Ok(ClaimError::NotOpen)));
    }

    #[test]
    #[should_panic]
    fn test_frontrun_recipient_substitution_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let attacker = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(admin);
        let token_id = token_contract.address();
        StellarAssetClient::new(&env, &token_id).mint(&sender, &200);

        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        let signing_key = SigningKey::from_bytes(&[11u8; 32]);
        let claim_pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
        let claim_id = BytesN::from_array(&env, &[2u8; 32]);

        client.create_claim(
            &claim_id,
            &sender,
            &token_id,
            &200,
            &claim_pubkey,
            &2_000,
            &true,
        );

        let sig_for_recipient =
            sign_claim_for_recipient(&env, &escrow_id, &claim_id, &recipient, &signing_key);
        client.claim(&claim_id, &attacker, &sig_for_recipient);
    }

    #[test]
    fn test_expiry_and_refund_guards() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(admin);
        let token_id = token_contract.address();
        let token = TokenClient::new(&env, &token_id);
        StellarAssetClient::new(&env, &token_id).mint(&sender, &300);

        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        let signing_key = SigningKey::from_bytes(&[5u8; 32]);
        let claim_pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
        let claim_id = BytesN::from_array(&env, &[3u8; 32]);

        client.create_claim(
            &claim_id,
            &sender,
            &token_id,
            &300,
            &claim_pubkey,
            &1_500,
            &true,
        );
        assert_eq!(token.balance(&sender), 0);

        assert_eq!(
            client.try_refund_expired(&claim_id),
            Err(Ok(ClaimError::NotExpiredYet))
        );

        env.ledger().with_mut(|li| {
            li.timestamp = 1_501;
        });

        let sig = sign_claim_for_recipient(&env, &escrow_id, &claim_id, &recipient, &signing_key);
        assert_eq!(
            client.try_claim(&claim_id, &recipient, &sig),
            Err(Ok(ClaimError::Expired))
        );

        client.refund_expired(&claim_id);
        assert_eq!(token.balance(&sender), 300);
        assert_eq!(token.balance(&escrow_id), 0);
        assert_eq!(client.get_escrowed_balance(&token_id), 0);
        assert_eq!(
            client.try_refund_expired(&claim_id),
            Err(Ok(ClaimError::NotOpen))
        );

        let stored = client.get_claim(&claim_id).expect("claim must exist");
        assert_eq!(stored.status, ClaimStatus::Refunded);
    }

    #[test]
    fn test_cancel_claim_early_and_validation_errors() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(admin);
        let token_id = token_contract.address();
        let token = TokenClient::new(&env, &token_id);
        StellarAssetClient::new(&env, &token_id).mint(&sender, &400);

        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        let signing_key = SigningKey::from_bytes(&[12u8; 32]);
        let claim_pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
        let claim_id = BytesN::from_array(&env, &[4u8; 32]);

        assert_eq!(
            client.try_create_claim(
                &claim_id,
                &sender,
                &token_id,
                &0,
                &claim_pubkey,
                &2_000,
                &true
            ),
            Err(Ok(ClaimError::InvalidAmount))
        );
        assert_eq!(
            client.try_create_claim(
                &claim_id,
                &sender,
                &token_id,
                &100,
                &claim_pubkey,
                &1_000,
                &true
            ),
            Err(Ok(ClaimError::InvalidExpiry))
        );
        assert_eq!(
            client.try_create_claim(
                &claim_id,
                &sender,
                &token_id,
                &100,
                &claim_pubkey,
                &(1_000 + MAX_CLAIM_DURATION_SECS + 1),
                &true
            ),
            Err(Ok(ClaimError::DurationTooLong))
        );
        assert_eq!(
            client.try_refund_expired(&claim_id),
            Err(Ok(ClaimError::NotFound))
        );

        client.create_claim(
            &claim_id,
            &sender,
            &token_id,
            &400,
            &claim_pubkey,
            &5_000,
            &true,
        );
        assert_eq!(
            client.try_create_claim(
                &claim_id,
                &sender,
                &token_id,
                &400,
                &claim_pubkey,
                &5_000,
                &true
            ),
            Err(Ok(ClaimError::AlreadyExists))
        );

        client.cancel_claim(&claim_id);
        assert_eq!(token.balance(&sender), 400);
        assert_eq!(token.balance(&escrow_id), 0);
        let stored = client.get_claim(&claim_id).expect("claim must exist");
        assert_eq!(stored.status, ClaimStatus::Cancelled);

        let sig = sign_claim_for_recipient(&env, &escrow_id, &claim_id, &recipient, &signing_key);
        assert_eq!(
            client.try_claim(&claim_id, &recipient, &sig),
            Err(Ok(ClaimError::NotOpen))
        );
    }

    #[test]
    #[should_panic]
    fn test_create_claim_requires_real_sender_auth() {
        let env = Env::default();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let sender = Address::generate(&env);
        let token_id = Address::generate(&env);
        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        let signing_key = SigningKey::from_bytes(&[19u8; 32]);
        let claim_pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
        let claim_id = BytesN::from_array(&env, &[9u8; 32]);

        client.create_claim(
            &claim_id,
            &sender,
            &token_id,
            &100,
            &claim_pubkey,
            &2_000,
            &true,
        );
    }

    #[test]
    fn test_cross_language_payload_encoding_vector() {
        let env = Env::default();
        let escrow_id = Address::from_str(
            &env,
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        );
        let recipient = Address::from_str(
            &env,
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        );
        let claim_id = BytesN::from_array(&env, &[1u8; 32]);

        let mut payload = Bytes::from_slice(&env, b"AW_CLAIM_V2:");
        payload.append(&escrow_id.to_xdr(&env));
        payload.append(&claim_id.into());
        payload.append(&recipient.to_xdr(&env));

        assert_eq!(payload.len(), 128);
        let mut buf = [0u8; 128];
        payload.copy_into_slice(&mut buf);
        assert_eq!(&buf[0..12], b"AW_CLAIM_V2:");
        assert_eq!(&buf[12..20], &[0, 0, 0, 18, 0, 0, 0, 1]);
        assert_eq!(&buf[20..52], &[0u8; 32]);
        assert_eq!(&buf[52..84], &[1u8; 32]);
        assert_eq!(&buf[84..92], &[0, 0, 0, 18, 0, 0, 0, 0]);
        assert_eq!(&buf[92..128], &[0u8; 36]);
    }

    #[test]
    fn test_rejects_fee_on_transfer_zero_claim_key_and_self_addresses() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let sender = Address::generate(&env);
        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        let fot_id = env.register(FeeOnTransferMockToken, ());
        let fot_client = FeeOnTransferMockTokenClient::new(&env, &fot_id);
        fot_client.mint(&sender, &1_000);

        let signing_key = SigningKey::from_bytes(&[21u8; 32]);
        let claim_pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
        let zero_key = BytesN::from_array(&env, &[0u8; 32]);
        let claim_id = BytesN::from_array(&env, &[10u8; 32]);

        assert_eq!(
            client.try_create_claim(&claim_id, &sender, &fot_id, &1_000, &zero_key, &2_000, &true),
            Err(Ok(ClaimError::InvalidClaimKey))
        );
        assert_eq!(
            client.try_create_claim(
                &claim_id,
                &sender,
                &escrow_id,
                &1_000,
                &claim_pubkey,
                &2_000,
                &true
            ),
            Err(Ok(ClaimError::InvalidAddress))
        );
        assert_eq!(
            client.try_create_claim(
                &claim_id,
                &sender,
                &fot_id,
                &1_000,
                &claim_pubkey,
                &2_000,
                &true
            ),
            Err(Ok(ClaimError::UnsupportedTokenBehavior))
        );
    }

    #[test]
    fn test_non_cancellable_claim_refund_to_and_extend_ttl() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);
        let alt_dest = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(admin);
        let token_id = token_contract.address();
        let token = TokenClient::new(&env, &token_id);
        StellarAssetClient::new(&env, &token_id).mint(&sender, &600);

        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        let signing_key = SigningKey::from_bytes(&[33u8; 32]);
        let claim_pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
        let claim_id = BytesN::from_array(&env, &[11u8; 32]);

        client.create_claim(
            &claim_id,
            &sender,
            &token_id,
            &600,
            &claim_pubkey,
            &2_000,
            &false,
        );

        assert_eq!(
            client.try_cancel_claim(&claim_id),
            Err(Ok(ClaimError::NotCancellable))
        );

        client.extend_claim_ttl(&claim_id);

        env.ledger().with_mut(|li| {
            li.timestamp = 2_001;
        });
        client.refund_expired_to(&claim_id, &alt_dest);
        assert_eq!(token.balance(&alt_dest), 600);
        assert_eq!(client.get_escrowed_balance(&token_id), 0);
        assert_eq!(
            client.try_extend_claim_ttl(&claim_id),
            Err(Ok(ClaimError::NotOpen))
        );
    }

    #[test]
    fn test_guardian_pause_only_deposits_and_rescue_excess_safety() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let treasury = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(admin);
        let token_id = token_contract.address();
        let sac = StellarAssetClient::new(&env, &token_id);
        let token = TokenClient::new(&env, &token_id);
        sac.mint(&sender, &1_000);

        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        assert_eq!(
            client.try_set_deposits_paused(&true),
            Err(Ok(ClaimError::NotInitialized))
        );
        client.init(&guardian);
        assert_eq!(
            client.try_init(&guardian),
            Err(Ok(ClaimError::AlreadyInitialized))
        );

        let signing_key = SigningKey::from_bytes(&[44u8; 32]);
        let claim_pubkey = BytesN::from_array(&env, &signing_key.verifying_key().to_bytes());
        let claim_1 = BytesN::from_array(&env, &[12u8; 32]);
        let claim_2 = BytesN::from_array(&env, &[13u8; 32]);

        client.create_claim(
            &claim_1,
            &sender,
            &token_id,
            &400,
            &claim_pubkey,
            &2_000,
            &true,
        );

        // Stray tokens sent directly to escrow contract
        sac.mint(&escrow_id, &150);

        // Guardian cannot rescue escrowed funds
        assert_eq!(
            client.try_rescue_excess(&token_id, &treasury, &200),
            Err(Ok(ClaimError::InsufficientExcess))
        );
        // Guardian can rescue strictly the 150 excess
        client.rescue_excess(&token_id, &treasury, &150);
        assert_eq!(token.balance(&treasury), 150);
        assert_eq!(token.balance(&escrow_id), 400);

        // Pausing blocks new deposits only, while existing claim remains claimable
        client.set_deposits_paused(&true);
        assert!(client.is_deposits_paused());
        assert_eq!(
            client.try_create_claim(
                &claim_2,
                &sender,
                &token_id,
                &100,
                &claim_pubkey,
                &2_000,
                &true
            ),
            Err(Ok(ClaimError::DepositsPaused))
        );

        let sig = sign_claim_for_recipient(&env, &escrow_id, &claim_1, &recipient, &signing_key);
        client.claim(&claim_1, &recipient, &sig);
        assert_eq!(token.balance(&recipient), 400);
        assert_eq!(client.get_escrowed_balance(&token_id), 0);
    }
}
