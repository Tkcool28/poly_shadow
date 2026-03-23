use std::collections::VecDeque;
use std::fs::{self, File};
use std::path::PathBuf;
use std::sync::Arc;

use arrow::array::{Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use tokio::sync::broadcast;
use tokio::time::{Duration, interval};

use super::PriceTick;

/// Spawn a tokio task that writes PriceTick events to daily parquet files.
pub fn spawn_parquet_writer(
    mut price_rx: broadcast::Receiver<PriceTick>,
    data_dir: String,
    flush_rows: usize,
    flush_interval_ms: u64,
) {
    tokio::spawn(async move {
        let data_path = PathBuf::from(&data_dir);
        if let Err(e) = fs::create_dir_all(&data_path) {
            tracing::error!(error = %e, dir = %data_dir, "failed to create parquet data dir");
            return;
        }
        tracing::info!(dir = %data_dir, flush_rows, flush_interval_ms, "parquet writer started");

        let mut buffer: VecDeque<PriceTick> = VecDeque::with_capacity(flush_rows);
        let mut flush_timer = interval(Duration::from_millis(flush_interval_ms));
        let mut total_written: u64 = 0;

        loop {
            tokio::select! {
                tick = price_rx.recv() => {
                    match tick {
                        Ok(t) => {
                            buffer.push_back(t);
                            if buffer.len() >= flush_rows {
                                total_written += flush_buffer(&mut buffer, &data_path);
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!(lagged = n, "parquet writer lagged, ticks dropped");
                        }
                        Err(_) => {
                            tracing::info!("parquet writer: broadcast channel closed, flushing final");
                            if !buffer.is_empty() {
                                total_written += flush_buffer(&mut buffer, &data_path);
                            }
                            break;
                        }
                    }
                }
                _ = flush_timer.tick() => {
                    if !buffer.is_empty() {
                        total_written += flush_buffer(&mut buffer, &data_path);
                    }
                }
            }
        }

        tracing::info!(total_rows = total_written, "parquet writer stopped");
    });
}

/// Flush buffered ticks to a parquet file. Returns number of rows written.
fn flush_buffer(buffer: &mut VecDeque<PriceTick>, data_dir: &PathBuf) -> u64 {
    let n = buffer.len();
    if n == 0 {
        return 0;
    }

    let now = chrono::Utc::now();
    let filename = format!("{}_{}.parquet", now.format("%Y-%m-%d"), now.format("%H%M%S"));
    let filepath = data_dir.join(&filename);

    let schema = Arc::new(Schema::new(vec![
        Field::new("timestamp_ms", DataType::Int64, false),
        Field::new("token_id", DataType::Utf8, false),
        Field::new("price", DataType::Float64, false),
        Field::new("size", DataType::Float64, false),
        Field::new("side", DataType::Utf8, false),
    ]));

    let timestamps: Vec<i64> = buffer.iter().map(|t| t.timestamp_ms).collect();
    let token_ids: Vec<&str> = buffer.iter().map(|t| t.token_id.as_str()).collect();
    let prices: Vec<f64> = buffer.iter().map(|t| t.price).collect();
    let sizes: Vec<f64> = buffer.iter().map(|t| t.size).collect();
    let sides: Vec<&str> = buffer.iter().map(|t| t.side.as_str()).collect();

    let batch = match RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int64Array::from(timestamps)),
            Arc::new(StringArray::from(token_ids)),
            Arc::new(Float64Array::from(prices)),
            Arc::new(Float64Array::from(sizes)),
            Arc::new(StringArray::from(sides)),
        ],
    ) {
        Ok(b) => b,
        Err(e) => {
            tracing::error!(error = %e, "failed to create record batch");
            buffer.clear();
            return 0;
        }
    };

    let file = match File::create(&filepath) {
        Ok(f) => f,
        Err(e) => {
            tracing::error!(error = %e, path = %filepath.display(), "failed to create parquet file");
            buffer.clear();
            return 0;
        }
    };

    let props = WriterProperties::builder()
        .set_compression(Compression::SNAPPY)
        .build();

    match ArrowWriter::try_new(file, schema, Some(props)) {
        Ok(mut writer) => {
            if let Err(e) = ArrowWriter::write(&mut writer, &batch) {
                tracing::error!(error = %e, "failed to write parquet batch");
            } else if let Err(e) = writer.close() {
                tracing::error!(error = %e, "failed to close parquet writer");
            } else {
                tracing::debug!(rows = n, path = %filepath.display(), "parquet flush");
            }
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to create parquet writer");
        }
    }

    buffer.clear();
    n as u64
}
