use director_core::Engine;
use serde_json::Value;
use std::{
    io::{self, Read},
    path::PathBuf,
};
fn main() {
    let mut args = std::env::args().skip(1);
    let first = args.next().unwrap_or_else(|| ".local".into());
    if first == "--recover-project-library" {
        let result = args.next().ok_or_else(|| "缺少项目库绝对路径".to_owned()).and_then(|path| {
            let home = PathBuf::from(path);
            if !home.is_absolute() { return Err("项目库路径必须为绝对路径".into()); }
            director_core::project_library::recover_virtualized(&home)
        });
        match result { Ok(value) => println!("{value}"), Err(error) => { eprintln!("{error}"); std::process::exit(1); } }
        return;
    }
    let home = PathBuf::from(first);
    let result = (|| {
        let engine = Engine::new(home)?;
        let mut body = String::new();
        io::stdin()
            .read_to_string(&mut body)
            .map_err(|e| e.to_string())?;
        let request: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        engine.dispatch(request)
    })();
    match result {
        Ok(v) => println!("{}", v),
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(1)
        }
    }
}
