use std::{io::Write, time::Duration};

use anyhow::{Context, Result};
use clap::Parser;
use dfs_api::search::{
    IndexCell, OBJECTS_INDEX_ALIAS, OBJECTS_INDEX_NAME, client::ConnectionConfig,
    create_objects_index, objects_index_body,
};

const REQUEST_TIMEOUT_SECONDS: u64 = 90;

#[derive(Parser)]
#[command(about = "Preview or create the DFS object search index and write alias")]
struct Args {
    #[arg(long, value_enum, env = "CELL")]
    cell: IndexCell,
    /// Create the index. Without this flag, print the request body without contacting Elasticsearch.
    #[arg(long)]
    execute: bool,
    #[command(flatten)]
    elasticsearch: ConnectionConfig,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .json()
        .init();

    if !args.execute {
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer_pretty(&mut stdout, &objects_index_body(args.cell)?)?;
        writeln!(stdout)?;
        return Ok(());
    }

    let client = args
        .elasticsearch
        .build(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))?
        .context("--url or ELASTICSEARCH_URL is required with --execute")?;
    create_objects_index(&client, args.cell).await?;
    tracing::info!(
        index = OBJECTS_INDEX_NAME,
        alias = OBJECTS_INDEX_ALIAS,
        "created DFS object index"
    );
    Ok(())
}
