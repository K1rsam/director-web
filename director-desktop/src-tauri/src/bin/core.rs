use director_core::Engine;
use serde_json::Value;
use std::{
    io::{self, Read},
    path::PathBuf,
};
fn main() {
    let mut args = std::env::args().skip(1);
    let home = PathBuf::from(args.next().unwrap_or_else(|| ".local".into()));
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
