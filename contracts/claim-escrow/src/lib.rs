#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Bytes, BytesN, Env,
};

const DAY_IN_LEDGERS: u32 = 17_280;
const CLAIM_TTL_THRESHOLD: u32 = DAY_IN_LEDGERS * 7;
const CLAIM_TTL_EXTEND_TO: u32 = DAY_IN_LEDGERS * 14;

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
    pub claim_hash: BytesN<32>,
    pub expires_at: u64,
    pub status: ClaimStatus,
}

#[contract]
pub struct ClaimEscrowContract;

#[contractimpl]
impl ClaimEscrowContract {
    /// Locks `amount` of `token` (SAC) into time-locked escrow for a Telegram Claim Link.
    /// Callable by the sender; refundable automatically after `expires_at`.
    pub fn create_claim(
        env: Env,
        claim_id: BytesN<32>,
        sender: Address,
        token: Address,
        amount: i128,
        claim_hash: BytesN<32>,
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

        let key = DataKey::Claim(claim_id);
        if env.storage().persistent().has(&key) {
            return Err(ClaimError::AlreadyExists);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        let deposit = ClaimDeposit {
            sender,
            token,
            amount,
            claim_hash,
            expires_at,
            status: ClaimStatus::Open,
        };
        env.storage().persistent().set(&key, &deposit);
        env.storage()
            .persistent()
            .extend_ttl(&key, CLAIM_TTL_THRESHOLD, CLAIM_TTL_EXTEND_TO);

        Ok(())
    }

    /// Claims an active Telegram Claim Link by presenting the 32-byte secret preimage
    /// whose SHA-256 matches `claim_hash`.
    pub fn claim(
        env: Env,
        claim_id: BytesN<32>,
        recipient: Address,
        secret_preimage: BytesN<32>,
    ) -> Result<(), ClaimError> {
        recipient.require_auth();

        let key = DataKey::Claim(claim_id);
        let mut deposit: ClaimDeposit = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ClaimError::NotFound)?;

        if deposit.status != ClaimStatus::Open {
            return Err(ClaimError::NotOpen);
        }
        if env.ledger().timestamp() > deposit.expires_at {
            return Err(ClaimError::Expired);
        }

        let preimage_bytes: Bytes = secret_preimage.into();
        let computed_hash: BytesN<32> = env.crypto().sha256(&preimage_bytes).into();
        if computed_hash != deposit.claim_hash {
            return Err(ClaimError::InvalidSecretPreimage);
        }

        // Checks-Effects-Interactions: mark Claimed before external token transfer
        deposit.status = ClaimStatus::Claimed;
        env.storage().persistent().set(&key, &deposit);

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(&env.current_contract_address(), &recipient, &deposit.amount);

        Ok(())
    }

    /// Returns unclaimed funds to the original sender once `expires_at` has passed.
    pub fn refund_expired(env: Env, claim_id: BytesN<32>) -> Result<(), ClaimError> {
        let key = DataKey::Claim(claim_id);
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

        let token_client = token::Client::new(&env, &deposit.token);
        token_client.transfer(
            &env.current_contract_address(),
            &deposit.sender,
            &deposit.amount,
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
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{StellarAssetClient, TokenClient},
        Env,
    };

    #[test]
    fn test_create_and_claim_with_valid_preimage() {
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

        let claim_id = BytesN::from_array(&env, &[1u8; 32]);
        let preimage = BytesN::from_array(&env, &[9u8; 32]);
        let preimage_bytes: Bytes = preimage.clone().into();
        let claim_hash: BytesN<32> = env.crypto().sha256(&preimage_bytes).into();

        client.create_claim(&claim_id, &sender, &token_id, &250, &claim_hash, &2_000);
        assert_eq!(token.balance(&sender), 250);
        assert_eq!(token.balance(&escrow_id), 250);

        // Wrong preimage must fail with InvalidSecretPreimage
        let bad_preimage = BytesN::from_array(&env, &[8u8; 32]);
        let bad_res = client.try_claim(&claim_id, &recipient, &bad_preimage);
        assert_eq!(bad_res, Err(Ok(ClaimError::InvalidSecretPreimage)));

        // Valid preimage claims and transfers tokens
        client.claim(&claim_id, &recipient, &preimage);
        assert_eq!(token.balance(&recipient), 250);
        assert_eq!(token.balance(&escrow_id), 0);

        let stored = client.get_claim(&claim_id).expect("claim must exist");
        assert_eq!(stored.status, ClaimStatus::Claimed);
    }

    #[test]
    fn test_refund_after_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
        });

        let admin = Address::generate(&env);
        let sender = Address::generate(&env);

        let token_contract = env.register_stellar_asset_contract_v2(admin);
        let token_id = token_contract.address();
        let sac = StellarAssetClient::new(&env, &token_id);
        let token = TokenClient::new(&env, &token_id);
        sac.mint(&sender, &300);

        let escrow_id = env.register(ClaimEscrowContract, ());
        let client = ClaimEscrowContractClient::new(&env, &escrow_id);

        let claim_id = BytesN::from_array(&env, &[2u8; 32]);
        let preimage = BytesN::from_array(&env, &[5u8; 32]);
        let preimage_bytes: Bytes = preimage.into();
        let claim_hash: BytesN<32> = env.crypto().sha256(&preimage_bytes).into();

        client.create_claim(&claim_id, &sender, &token_id, &300, &claim_hash, &1_500);
        assert_eq!(token.balance(&sender), 0);

        // Advance past expires_at and refund
        env.ledger().with_mut(|li| {
            li.timestamp = 1_501;
        });
        client.refund_expired(&claim_id);
        assert_eq!(token.balance(&sender), 300);
        assert_eq!(token.balance(&escrow_id), 0);

        let stored = client.get_claim(&claim_id).expect("claim must exist");
        assert_eq!(stored.status, ClaimStatus::Refunded);
    }
}
