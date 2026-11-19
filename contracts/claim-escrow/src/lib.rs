#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, xdr::ToXdr, Address,
    Bytes, BytesN, Env,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const CLAIM_TTL_MIN_LEDGERS: u32 = DAY_IN_LEDGERS * 14;
const CLAIM_TTL_MAX_LEDGERS: u32 = DAY_IN_LEDGERS * 45;
const CLAIM_TTL_BUFFER_LEDGERS: u32 = DAY_IN_LEDGERS * 7;
const INSTANCE_TTL_THRESHOLD: u32 = DAY_IN_LEDGERS * 7;
const INSTANCE_TTL_EXTEND_TO: u32 = DAY_IN_LEDGERS * 30;
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
    InvalidSecretPreimage = 8,
    DurationTooLong = 9,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ClaimStatus {
    Open = 0,
    Claimed = 1,
    Refunded = 2,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Claim(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimDeposit {
    pub sender: Address,
    pub token: Address,
    pub amount: i128,
    pub claim_pubkey: BytesN<32>,
    pub expires_at: u64,
    pub status: ClaimStatus,
}

fn compute_claim_ttl_ledgers(now: u64, expires_at: u64) -> u32 {
    let duration_secs = expires_at.saturating_sub(now);
    let duration_ledgers = (duration_secs / 5).min(u32::MAX as u64) as u32;
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

#[contract]
pub struct ClaimEscrowContract;

#[contractimpl]
impl ClaimEscrowContract {
    /// Locks `amount` of `token` (SAC) into time-locked escrow for a Telegram Claim Link
    /// authorized by an ephemeral Ed25519 public key (`claim_pubkey`).
    pub fn create_claim(
        env: Env,
        claim_id: BytesN<32>,
        sender: Address,
        token: Address,
        amount: i128,
        claim_pubkey: BytesN<32>,
        expires_at: u64,
    ) -> Result<(), ClaimError> {
        sender.require_auth();

        if amount <= 0 {
            return Err(ClaimError::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if expires_at <= now {
            return Err(ClaimError::InvalidExpiry);
        }
        if expires_at - now > MAX_CLAIM_DURATION_SECS {
            return Err(ClaimError::DurationTooLong);
        }

        let key = DataKey::Claim(claim_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(ClaimError::AlreadyExists);
        }

        let deposit = ClaimDeposit {
            sender: sender.clone(),
            token: token.clone(),
            amount,
            claim_pubkey,
            expires_at,
            status: ClaimStatus::Open,
        };

        // Checks-Effects-Interactions: persist deposit and extend TTLs before external transfer.
        let ttl_ledgers = compute_claim_ttl_ledgers(now, expires_at);
        let ttl_threshold = ttl_ledgers / 2;
        env.storage().persistent().set(&key, &deposit);
        env.storage()
            .persistent()
            .extend_ttl(&key, ttl_threshold, ttl_ledgers);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("created"), claim_id),
            (sender, token, amount, expires_at),
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

        let key = DataKey::Claim(claim_id.clone());
        let mut deposit: ClaimDeposit = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ClaimError::NotFound)?;

        if deposit.status != ClaimStatus::Open {
            return Err(ClaimError::NotOpen);
        }
        let now = env.ledger().timestamp();
        if now > deposit.expires_at {
            return Err(ClaimError::Expired);
        }

        let payload = build_claim_sign_payload(&env, &claim_id, &recipient);
        env.crypto()
            .ed25519_verify(&deposit.claim_pubkey, &payload, &signature);

        // Checks-Effects-Interactions: mark Claimed before external token transfer.
        deposit.status = ClaimStatus::Claimed;
        let ttl_ledgers = compute_claim_ttl_ledgers(now, deposit.expires_at);
        env.storage().persistent().set(&key, &deposit);
        env.storage()
            .persistent()
            .extend_ttl(&key, ttl_ledgers / 2, ttl_ledgers);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(&env.current_contract_address(), &recipient, &deposit.amount);

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("claimed"), claim_id),
            (recipient, deposit.token, deposit.amount),
        );

        Ok(())
    }

    /// Returns unclaimed funds to the original sender once `expires_at` has passed.
    pub fn refund_expired(env: Env, claim_id: BytesN<32>) -> Result<(), ClaimError> {
        let key = DataKey::Claim(claim_id.clone());
        let mut deposit: ClaimDeposit = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ClaimError::NotFound)?;

        if deposit.status != ClaimStatus::Open {
            return Err(ClaimError::NotOpen);
        }
        if env.ledger().timestamp() <= deposit.expires_at {
            return Err(ClaimError::NotExpiredYet);
        }

        deposit.status = ClaimStatus::Refunded;
        env.storage().persistent().set(&key, &deposit);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(
            &env.current_contract_address(),
            &deposit.sender,
            &deposit.amount,
        );

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("refunded"), claim_id),
            (deposit.sender, deposit.token, deposit.amount),
        );

        Ok(())
    }

    /// Allows the original sender to cancel an open claim early and reclaim escrowed funds.
    pub fn cancel_claim(env: Env, claim_id: BytesN<32>) -> Result<(), ClaimError> {
        let key = DataKey::Claim(claim_id.clone());
        let mut deposit: ClaimDeposit = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ClaimError::NotFound)?;

        deposit.sender.require_auth();

        if deposit.status != ClaimStatus::Open {
            return Err(ClaimError::NotOpen);
        }

        deposit.status = ClaimStatus::Refunded;
        env.storage().persistent().set(&key, &deposit);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(
            &env.current_contract_address(),
            &deposit.sender,
            &deposit.amount,
        );

        env.events().publish(
            (symbol_short!("claim"), symbol_short!("cancelled"), claim_id),
            (deposit.sender, deposit.token, deposit.amount),
        );

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
        testutils::{Address as _, Ledger},
        token::{StellarAssetClient, TokenClient},
        Env,
    };

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

        client.create_claim(&claim_id, &sender, &token_id, &250, &claim_pubkey, &2_000);
        assert_eq!(token.balance(&sender), 250);
        assert_eq!(token.balance(&escrow_id), 250);

        let sig = sign_claim_for_recipient(&env, &escrow_id, &claim_id, &recipient, &signing_key);
        client.claim(&claim_id, &recipient, &sig);

        assert_eq!(token.balance(&recipient), 250);
        assert_eq!(token.balance(&escrow_id), 0);

        let stored = client.get_claim(&claim_id).expect("claim must exist");
        assert_eq!(stored.status, ClaimStatus::Claimed);

        // Double-claim must fail with NotOpen
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

        client.create_claim(&claim_id, &sender, &token_id, &200, &claim_pubkey, &2_000);

        // Signature was issued strictly for `recipient`, so `attacker` cannot hijack it.
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

        client.create_claim(&claim_id, &sender, &token_id, &300, &claim_pubkey, &1_500);
        assert_eq!(token.balance(&sender), 0);

        // Early refund rejected
        assert_eq!(
            client.try_refund_expired(&claim_id),
            Err(Ok(ClaimError::NotExpiredYet))
        );

        // Advance past expires_at
        env.ledger().with_mut(|li| {
            li.timestamp = 1_501;
        });

        // Expired claim rejected
        let sig = sign_claim_for_recipient(&env, &escrow_id, &claim_id, &recipient, &signing_key);
        assert_eq!(
            client.try_claim(&claim_id, &recipient, &sig),
            Err(Ok(ClaimError::Expired))
        );

        // Refund succeeds and double refund is rejected
        client.refund_expired(&claim_id);
        assert_eq!(token.balance(&sender), 300);
        assert_eq!(token.balance(&escrow_id), 0);
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

        // Validation errors
        assert_eq!(
            client.try_create_claim(&claim_id, &sender, &token_id, &0, &claim_pubkey, &2_000),
            Err(Ok(ClaimError::InvalidAmount))
        );
        assert_eq!(
            client.try_create_claim(&claim_id, &sender, &token_id, &100, &claim_pubkey, &1_000),
            Err(Ok(ClaimError::InvalidExpiry))
        );
        assert_eq!(
            client.try_create_claim(
                &claim_id,
                &sender,
                &token_id,
                &100,
                &claim_pubkey,
                &(1_000 + MAX_CLAIM_DURATION_SECS + 1)
            ),
            Err(Ok(ClaimError::DurationTooLong))
        );
        assert_eq!(
            client.try_refund_expired(&claim_id),
            Err(Ok(ClaimError::NotFound))
        );

        // Create and verify duplicate rejected
        client.create_claim(&claim_id, &sender, &token_id, &400, &claim_pubkey, &5_000);
        assert_eq!(
            client.try_create_claim(&claim_id, &sender, &token_id, &400, &claim_pubkey, &5_000),
            Err(Ok(ClaimError::AlreadyExists))
        );

        // Sender cancels early
        client.cancel_claim(&claim_id);
        assert_eq!(token.balance(&sender), 400);
        assert_eq!(token.balance(&escrow_id), 0);

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

        client.create_claim(&claim_id, &sender, &token_id, &100, &claim_pubkey, &2_000);
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
}
