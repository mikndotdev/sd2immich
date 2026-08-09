//! API-key storage in the OS keychain (macOS Keychain / Windows Credential Manager /
//! Linux Secret Service) via the `keyring` crate. Keyed by server URL so multiple servers
//! can coexist. The secret never touches the JS side or the on-disk settings store.

use keyring::{Entry, Error as KeyringError};

const SERVICE: &str = "dev.mikn.sd2immich";

fn entry(server_url: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, server_url).map_err(|e| e.to_string())
}

pub fn set_api_key(server_url: &str, api_key: &str) -> Result<(), String> {
    entry(server_url)?
        .set_password(api_key)
        .map_err(|e| e.to_string())
}

pub fn get_api_key(server_url: &str) -> Result<Option<String>, String> {
    match entry(server_url)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete_api_key(server_url: &str) -> Result<(), String> {
    match entry(server_url)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
