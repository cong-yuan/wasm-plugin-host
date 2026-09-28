use anyhow::{Context, Result};
use std::{env, fs};

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let input = args.next().context("missing input core wasm path")?;
    let output = args.next().context("missing output component path")?;
    let module = fs::read(&input).with_context(|| format!("reading {input}"))?;
    let component = wit_component::ComponentEncoder::default()
        .module(&module)?
        .validate(true)
        .encode()?;
    fs::write(&output, component).with_context(|| format!("writing {output}"))?;
    println!("{output}");
    Ok(())
}
