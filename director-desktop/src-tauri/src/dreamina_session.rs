//! Official OAuth device flow. Authentication stays in the CLI's native store.
//! Only safe account projections leave this module; device codes never enter SQLite or logs.
use crate::{
    providers::{self, ProviderConfig, ProviderError, ProviderResult},
    store::{id, now, s, Result},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

struct Flow {
    id: String,
    device_code: String,
    expires: Instant,
    next_poll: Instant,
    interval: Duration,
}
struct Entry {
    public: Value,
    checked: Instant,
    flow: Option<Flow>,
}
#[derive(Default)]
pub struct DreaminaSessions {
    entries: Mutex<HashMap<String, Entry>>,
}
pub fn config_key(config: &ProviderConfig) -> String {
    let path = config
        .cli_path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}
fn unknown() -> Value {
    json!({"status":"unknown","ready":false,"identityVerified":false,"accountKey":null,"checkedAt":null,"credits":{"total":null,"member":null,"gift":null,"purchase":null},"message":"正在检查本机即梦 CLI 登录；也可在渠道设置中刷新。"})
}
pub fn authorization_url(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value).map_err(|_| "即梦授权链接无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("jimeng.jianying.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || url.fragment().is_some()
        || url.query_pairs().any(|(k, _)| {
            let k = k.to_ascii_lowercase();
            k == "device_code" || k == "devicecode" || k.contains("token")
        })
    {
        return Err("授权页必须为即梦官方 HTTPS 链接，不得携带内部设备凭据".into());
    }
    Ok(url.to_string())
}
impl DreaminaSessions {
    pub fn snapshot(&self, config: &ProviderConfig) -> Result<Value> {
        Ok(self
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(&config_key(config))
            .map(|e| e.public.clone())
            .unwrap_or_else(unknown))
    }
    fn save(&self, config: &ProviderConfig, public: Value) -> Result<Value> {
        self.entries.lock().map_err(|e| e.to_string())?.insert(
            config_key(config),
            Entry {
                public: public.clone(),
                checked: Instant::now(),
                flow: None,
            },
        );
        Ok(public)
    }
    pub fn due(&self, config: &ProviderConfig) -> Result<bool> {
        let entries = self.entries.lock().map_err(|e| e.to_string())?;
        Ok(match entries.get(&config_key(config)) {
            None => true,
            Some(e) => match &e.flow {
                Some(f) => Instant::now() >= f.next_poll || Instant::now() >= f.expires,
                None => e.checked.elapsed() >= Duration::from_secs(60),
            },
        })
    }
    pub fn forget(&self, config: &ProviderConfig) -> Result<()> {
        self.entries
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&config_key(config));
        Ok(())
    }
    pub fn refresh(&self, config: &ProviderConfig) -> Result<Value> {
        if self
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(&config_key(config))
            .is_some_and(|e| e.flow.is_some())
        {
            return self.poll_or_refresh(config);
        }
        match providers::dreamina_account(config) {
            Ok(account) => self.save(config, account),
            Err(e) => {
                let mut value = unknown();
                value["status"] = json!(if e.auth_required {
                    "logged_out"
                } else {
                    "error"
                });
                value["message"] = json!(e.message);
                value["checkedAt"] = json!(now());
                self.save(config, value)
            }
        }
    }
    pub fn fresh_identity(&self, config: &ProviderConfig) -> ProviderResult<String> {
        self.fresh_identity_with(config, providers::dreamina_account)
    }
    fn fresh_identity_with(
        &self,
        config: &ProviderConfig,
        account: impl FnOnce(&ProviderConfig) -> ProviderResult<Value>,
    ) -> ProviderResult<String> {
        if self
            .entries
            .lock()
            .map_err(|_| ProviderError::new("LOCAL_ACCOUNT_STATE", "即梦本地账户状态无法读取。"))?
            .get(&config_key(config))
            .is_some_and(|e| e.flow.is_some())
        {
            let mut error = ProviderError::auth();
            error.message = "即梦正在等待用户授权，请完成官方授权后继续。".into();
            return Err(error);
        }
        // UI refresh returns a safe status projection. Execution must retain the
        // provider's error flags instead of turning every failed check into logout.
        let account = match account(config) {
            Ok(value) => self.save(config, value).map_err(|_| {
                ProviderError::new("LOCAL_ACCOUNT_STATE", "即梦本地账户状态无法保存。")
            })?,
            Err(error) => {
                let mut value = unknown();
                value["status"] = json!(if error.auth_required {
                    "logged_out"
                } else {
                    "error"
                });
                value["message"] = json!(error.message);
                value["errorCode"] = json!(error.code);
                value["checkedAt"] = json!(now());
                self.save(config, value).map_err(|_| {
                    ProviderError::new("LOCAL_ACCOUNT_STATE", "即梦本地账户状态无法保存。")
                })?;
                return Err(error);
            }
        };
        if account["ready"] != true
            || account["identityVerified"] != true
            || s(&account, "accountKey").is_empty()
        {
            let mut error = ProviderError::new(
                "ACCOUNT_IDENTITY_UNVERIFIED",
                s(&account, "message").to_owned(),
            );
            error.auth_required = true;
            return Err(error);
        }
        Ok(s(&account, "accountKey").to_owned())
    }
    pub fn begin(&self, config: &ProviderConfig) -> Result<Value> {
        let current = self.snapshot(config)?;
        if s(&current, "status") == "authorizing" {
            let active = self
                .entries
                .lock()
                .map_err(|e| e.to_string())?
                .get(&config_key(config))
                .and_then(|e| e.flow.as_ref())
                .is_some_and(|f| Instant::now() < f.expires);
            if active {
                return Ok(current);
            }
            self.forget(config)?;
        }
        let response = providers::dreamina_begin_login(config).map_err(|e| e.message)?;
        if s(&response, "status") == "authenticated" {
            return self.save(config, response);
        }
        self.install_flow(config, &response)
    }
    fn install_flow(&self, config: &ProviderConfig, response: &Value) -> Result<Value> {
        let code = response
            .get("device_code")
            .or_else(|| response.get("deviceCode"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("CLI 未返回可检查的授权流程")?
            .to_owned();
        let user_code = response
            .get("user_code")
            .or_else(|| response.get("userCode"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let url = response
            .get("verification_uri_complete")
            .or_else(|| response.get("verification_url"))
            .or_else(|| response.get("verification_uri"))
            .and_then(Value::as_str)
            .ok_or("CLI 未返回官方授权链接")?;
        let url = authorization_url(url)?;
        if reqwest::Url::parse(&url)
            .map_err(|_| "即梦授权链接无效")?
            .query_pairs()
            .any(|(_, v)| v.contains(&code))
        {
            return Err("CLI 授权链接含内部设备凭据，未打开授权页。".into());
        }
        let seconds = response["expires_in"].as_u64().unwrap_or(600).min(900);
        if seconds == 0 {
            return Err("即梦授权流程已过期，请重新连接。".into());
        }
        let interval = response["interval"].as_u64().unwrap_or(5).max(3);
        let value = json!({"status":"authorizing","ready":false,"identityVerified":false,"accountKey":null,"checkedAt":now(),"credits":{"total":null,"member":null,"gift":null,"purchase":null},"message":"请在即梦官方授权页确认，工作台会自动同步登录与积分。","authorization":{"verificationUrl":url,"userCode":user_code,"expiresAt":(chrono::Utc::now()+chrono::Duration::seconds(seconds as i64)).to_rfc3339(),"pollIntervalSeconds":interval}});
        self.entries.lock().map_err(|e| e.to_string())?.insert(
            config_key(config),
            Entry {
                public: value.clone(),
                checked: Instant::now(),
                flow: Some(Flow {
                    id: id(),
                    device_code: code,
                    expires: Instant::now() + Duration::from_secs(seconds),
                    next_poll: Instant::now() + Duration::from_secs(interval),
                    interval: Duration::from_secs(interval),
                }),
            },
        );
        Ok(value)
    }
    pub fn poll_or_refresh(&self, config: &ProviderConfig) -> Result<Value> {
        let flow = {
            let entries = self.entries.lock().map_err(|e| e.to_string())?;
            entries
                .get(&config_key(config))
                .and_then(|e| e.flow.as_ref())
                .map(|f| (f.id.clone(), f.device_code.clone(), f.expires, f.next_poll))
        };
        let Some((flow_id, code, expires, next_poll)) = flow else {
            return self.refresh(config);
        };
        if Instant::now() >= expires {
            let mut value = unknown();
            value["status"] = json!("logged_out");
            value["message"] = json!("授权已超时，请重新连接即梦。");
            value["checkedAt"] = json!(now());
            return self.save(config, value);
        }
        if Instant::now() < next_poll {
            return self.snapshot(config);
        }
        let outcome = providers::dreamina_check_login(config, &code);
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        let Some(entry) = entries.get_mut(&config_key(config)) else {
            return Ok(unknown());
        };
        if !entry.flow.as_ref().is_some_and(|f| f.id == flow_id) {
            return Ok(entry.public.clone());
        }
        entry.checked = Instant::now();
        match outcome {
            Ok(account) if s(&account, "status") == "pending" => {
                if let Some(f) = &mut entry.flow {
                    if account["slowDown"] == true {
                        f.interval += Duration::from_secs(5);
                    }
                    f.next_poll = Instant::now() + f.interval;
                    entry.public["authorization"]["pollIntervalSeconds"] =
                        json!(f.interval.as_secs());
                }
            }
            Ok(account) => {
                entry.public = account;
                entry.flow = None;
            }
            Err(error) => {
                entry.public = unknown();
                entry.public["status"] = json!(if error.auth_required {
                    "logged_out"
                } else {
                    "error"
                });
                entry.public["message"] = json!(error.message);
                entry.public["checkedAt"] = json!(now());
                entry.flow = None;
            }
        }
        Ok(entry.public.clone())
    }
    pub fn logout(&self, config: &ProviderConfig) -> Result<Value> {
        providers::dreamina_logout(config).map_err(|e| e.message)?;
        let mut value = unknown();
        value["status"] = json!("logged_out");
        value["message"] = json!("本机官方 CLI 已退出登录，云端任务不会取消。");
        value["checkedAt"] = json!(now());
        self.save(config, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_identity_keeps_transient_provider_errors_typed_without_claiming_logout() {
        let sessions = DreaminaSessions::default();
        let config: ProviderConfig =
            serde_json::from_value(json!({"kind":"dreamina","cliPath":"C:/offline/never-run.exe"}))
                .unwrap();
        let expected = ProviderError::new("CLI_QUERY_FAILED", "safe diagnostic");
        let error = sessions
            .fresh_identity_with(&config, |_| Err(expected.clone()))
            .unwrap_err();
        assert_eq!(error.code, expected.code);
        assert_eq!(error.message, expected.message);
        assert!(!error.auth_required);
        assert!(!error.submission_unknown);
        let view = sessions.snapshot(&config).unwrap();
        assert_eq!(view["status"], "error");
        assert_eq!(view["errorCode"], "CLI_QUERY_FAILED");
        assert_eq!(view["ready"], false);
    }
    #[test]
    fn fresh_identity_keeps_real_authentication_failures_and_requires_verified_identity() {
        let sessions = DreaminaSessions::default();
        let config: ProviderConfig =
            serde_json::from_value(json!({"kind":"dreamina","cliPath":"C:/offline/never-run.exe"}))
                .unwrap();
        let error = sessions
            .fresh_identity_with(&config, |_| Err(ProviderError::auth()))
            .unwrap_err();
        assert!(error.auth_required);
        assert_eq!(sessions.snapshot(&config).unwrap()["status"], "logged_out");
        let error=sessions.fresh_identity_with(&config, |_|Ok(json!({"ready":true,"identityVerified":false,"accountKey":"untrusted","message":"identity missing"}))).unwrap_err();
        assert!(error.auth_required);
        assert_eq!(error.code, "ACCOUNT_IDENTITY_UNVERIFIED");
        let identity=sessions.fresh_identity_with(&config, |_|Ok(json!({"ready":true,"identityVerified":true,"accountKey":"verified-offline-account"}))).unwrap();
        assert_eq!(identity, "verified-offline-account");
    }
    #[test]
    fn authorization_links_require_official_https_and_never_expose_internal_codes() {
        assert!(
            authorization_url("https://jimeng.jianying.com/ai-tool/auth?user_code=ABCD").is_ok()
        );
        for url in [
            "https://jimeng.jianying.com.evil.test/",
            "http://jimeng.jianying.com/",
            "https://evil.test/",
            "https://u:p@jimeng.jianying.com/",
            "https://jimeng.jianying.com/?device_code=secret",
            "https://jimeng.jianying.com/#token",
        ] {
            assert!(authorization_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn account_cache_is_scoped_to_cli_and_device_secrets_are_never_projected() {
        let sessions = DreaminaSessions::default();
        let c: ProviderConfig =
            serde_json::from_value(json!({"kind":"dreamina","cliPath":"C:/official/dreamina.exe"}))
                .unwrap();
        let view = json!({"status":"authorizing","ready":false,"authorization":{"userCode":"PUBLIC","verificationUrl":"https://jimeng.jianying.com/"}});
        sessions.entries.lock().unwrap().insert(
            config_key(&c),
            Entry {
                public: view.clone(),
                checked: Instant::now(),
                flow: Some(Flow {
                    id: "flow".into(),
                    device_code: "INTERNAL_SECRET".into(),
                    expires: Instant::now() + Duration::from_secs(20),
                    next_poll: Instant::now() + Duration::from_secs(20),
                    interval: Duration::from_secs(5),
                }),
            },
        );
        assert_eq!(sessions.snapshot(&c).unwrap(), view);
        assert!(!sessions
            .snapshot(&c)
            .unwrap()
            .to_string()
            .contains("INTERNAL_SECRET"));
        assert!(!sessions.due(&c).unwrap());
        // Neither repeated status refresh nor a generation preflight destroys a live flow.
        // The CLI path intentionally does not exist: these calls must not launch it.
        assert_eq!(sessions.poll_or_refresh(&c).unwrap(), view);
        assert_eq!(sessions.refresh(&c).unwrap(), view);
        assert!(sessions.fresh_identity(&c).is_err());
        assert_eq!(sessions.snapshot(&c).unwrap(), view);
        let other: ProviderConfig =
            serde_json::from_value(json!({"kind":"dreamina","cliPath":"C:/other/dreamina.exe"}))
                .unwrap();
        assert_eq!(sessions.snapshot(&other).unwrap()["status"], "unknown");
    }
    #[test]
    fn oauth_server_timing_is_respected_and_secret_urls_are_rejected() {
        let sessions = DreaminaSessions::default();
        let c: ProviderConfig = serde_json::from_value(
            json!({"kind":"dreamina","cliPath":"C:/nonexistent/dreamina.exe"}),
        )
        .unwrap();
        let response = json!({"device_code":"PRIVATE_DEVICE","verification_uri":"https://jimeng.jianying.com/ai-tool/auth","user_code":"PUBLIC","expires_in":5,"interval":60});
        let view = sessions.install_flow(&c, &response).unwrap();
        assert_eq!(view["authorization"]["pollIntervalSeconds"], 60);
        let entries = sessions.entries.lock().unwrap();
        let flow = entries.get(&config_key(&c)).unwrap().flow.as_ref().unwrap();
        assert!(flow.expires.saturating_duration_since(Instant::now()) <= Duration::from_secs(5));
        assert_eq!(flow.interval, Duration::from_secs(60));
        drop(entries);
        let mut bad = response.clone();
        bad["verification_uri"] = json!("https://jimeng.jianying.com/auth?code=PRIVATE_DEVICE");
        assert!(sessions.install_flow(&c, &bad).is_err());
        for url in [
            "https://jimeng.jianying.com/auth?deviceCode=private",
            "https://jimeng.jianying.com/auth?session_token=private",
        ] {
            assert!(authorization_url(url).is_err());
        }
    }
}
