//! `podvision --regions <json> --model <file> [--model <file>…] [--image <file>|-] [--scale auto|1|2|4|8]`
//!
//! Prints one JSON object on stdout (see `podvision::run`). The still is read
//! from stdin unless `--image` names a file. Exit codes: 0 ok, 1 I/O, 2 usage,
//! 3 a bad weights file, 4 a bad still. Core runs it at nice 19 under a timeout
//! and falls back to its TypeScript runner on any failure (#191).

use podvision::{model::Model, parse_regions, run, Failure, Job};
use std::io::{Read, Write};

/// A still larger than this is not one of ours.
const MAX_JPEG_BYTES: u64 = 32 << 20;

const USAGE: &str = "usage: podvision --regions <json> --model <file> [--model <file>...] [--image <file>|-] [--scale auto|1|2|4|8]";

struct Args {
    image: String,
    regions: String,
    models: Vec<String>,
    eighths: Option<usize>,
}

fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<Option<Args>, Failure> {
    let mut a = Args {
        image: "-".into(),
        regions: String::new(),
        models: vec![],
        eighths: None,
    };
    let usage = |m: &str| Failure::Usage(format!("{m}\n{USAGE}"));
    while let Some(flag) = argv.next() {
        let mut value = || argv.next().ok_or_else(|| usage(&format!("{flag} needs a value")));
        match flag.as_str() {
            "--version" => return Ok(None),
            "--image" => a.image = value()?,
            "--regions" => a.regions = value()?,
            "--model" => a.models.push(value()?),
            "--scale" => {
                a.eighths = match value()?.as_str() {
                    "auto" => None,
                    "1" => Some(8),
                    "2" => Some(4),
                    "4" => Some(2),
                    "8" => Some(1),
                    s => return Err(usage(&format!("--scale {s}: give auto, 1, 2, 4 or 8"))),
                }
            }
            _ => return Err(usage(&format!("unknown option {flag}"))),
        }
    }
    if a.regions.is_empty() || a.models.is_empty() {
        return Err(usage("--regions and at least one --model are required"));
    }
    Ok(Some(a))
}

/// Ask the kernel to kill this process first if memory runs out, never core or hald.
fn prefer_oom_kill() {
    #[cfg(target_os = "linux")]
    let _ = std::fs::write("/proc/self/oom_score_adj", "1000");
}

fn read_capped(r: impl Read, what: &str) -> Result<Vec<u8>, Failure> {
    let mut buf = Vec::new();
    r.take(MAX_JPEG_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| Failure::Io(format!("reading {what}: {e}")))?;
    if buf.len() as u64 > MAX_JPEG_BYTES {
        return Err(Failure::Image(format!(
            "{what} is larger than {MAX_JPEG_BYTES} bytes"
        )));
    }
    Ok(buf)
}

fn main_inner() -> Result<Option<serde_json::Value>, Failure> {
    let Some(args) = parse_args(std::env::args().skip(1))? else {
        return Ok(None);
    };
    prefer_oom_kill();
    let regions = parse_regions(&args.regions)?;
    let models = args
        .models
        .iter()
        .map(|p| {
            let text = std::fs::read_to_string(p).map_err(|e| Failure::Model(format!("{p}: {e}")))?;
            Model::parse(&text).map_err(|e| Failure::Model(format!("{p}: {e}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let jpeg = if args.image == "-" {
        read_capped(std::io::stdin().lock(), "stdin")?
    } else {
        let f =
            std::fs::File::open(&args.image).map_err(|e| Failure::Image(format!("{}: {e}", args.image)))?;
        read_capped(f, &args.image)?
    };
    run(&Job {
        jpeg: &jpeg,
        regions: &regions,
        models: &models,
        eighths: args.eighths,
    })
    .map(Some)
}

fn main() {
    match main_inner() {
        Ok(None) => println!("podvision {}", env!("CARGO_PKG_VERSION")),
        Ok(Some(out)) => {
            let mut stdout = std::io::stdout().lock();
            if writeln!(stdout, "{out}").is_err() {
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("podvision: {}", e.message());
            std::process::exit(e.code());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Option<Args>, Failure> {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parses_its_arguments() {
        let a = args(&[
            "--regions",
            "{}",
            "--model",
            "a.json",
            "--model",
            "b.json",
            "--image",
            "x.jpg",
            "--scale",
            "4",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(
            (a.image.as_str(), a.models.len(), a.eighths),
            ("x.jpg", 2, Some(2))
        );
        let a = args(&["--regions", "{}", "--model", "a.json", "--scale", "auto"])
            .unwrap()
            .unwrap();
        assert_eq!((a.image.as_str(), a.eighths), ("-", None));
        for (s, e) in [("1", 8), ("2", 4), ("8", 1)] {
            assert_eq!(
                args(&["--regions", "{}", "--model", "m", "--scale", s])
                    .unwrap()
                    .unwrap()
                    .eighths,
                Some(e)
            );
        }
        assert!(args(&["--version"]).unwrap().is_none());
    }

    #[test]
    fn refuses_bad_arguments_as_usage_errors() {
        for bad in [
            &["--model"][..],
            &["--regions", "{}"],
            &["--bogus"],
            &["--regions", "{}", "--model", "m", "--scale", "3"],
        ] {
            assert_eq!(args(bad).err().map(|e| e.code()), Some(2), "{bad:?}");
        }
    }

    #[test]
    fn caps_what_it_reads() {
        assert_eq!(read_capped(&b"abc"[..], "stdin").unwrap(), b"abc");
        let big = std::io::repeat(0).take(MAX_JPEG_BYTES + 10);
        assert_eq!(read_capped(big, "stdin").unwrap_err().code(), 4);
    }
}
