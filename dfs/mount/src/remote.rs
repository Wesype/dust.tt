use crate::errno::Errno;
use dfs_protocol::{
    LIST_MAX_ENTRIES, LOOKUP_MAX_TARGETS, ObjectId, ObjectRef, STAT_MAX_REFERENCES,
    rpc::{
        Attr, AttrBatch, Empty, Entry, ListRequest, LookupRequest, LookupTarget, ReadData,
        ReadRequest, Session, StatRequest, dfs_client::DfsClient,
    },
};
use tonic::{Request, metadata::AsciiMetadataValue, transport::Channel};

/// The mount's connection to the dfs server, authenticated with one session key. The caller builds
/// the channel, TLS included.
#[derive(Clone)]
pub struct Remote {
    client: DfsClient<Channel>,
    authorization: AsciiMetadataValue,
}

impl Remote {
    /// Fails with `EINVAL` if the key cannot be sent as a header.
    pub fn new(channel: Channel, session_key: &str) -> Result<Self, Errno> {
        let mut authorization: AsciiMetadataValue = format!("Bearer {session_key}")
            .parse()
            .map_err(|_| Errno::EINVAL)?;
        authorization.set_sensitive(true);
        Ok(Self {
            client: DfsClient::new(channel),
            authorization,
        })
    }

    fn request<T>(&self, message: T) -> Request<T> {
        let mut request = Request::new(message);
        request
            .metadata_mut()
            .insert("authorization", self.authorization.clone());
        request
    }

    pub async fn current_session(&self) -> Result<Session, Errno> {
        let response = self
            .client
            .clone()
            .current_session(self.request(Empty {}))
            .await?;
        Ok(response.into_inner())
    }

    /// Extends the session. Sessions expire one hour after their last refresh.
    pub async fn refresh_session(&self) -> Result<Session, Errno> {
        let response = self
            .client
            .clone()
            .refresh_session(self.request(Empty {}))
            .await?;
        Ok(response.into_inner())
    }

    /**
     * @cc [owner:fontanierh,label:api] stat-batch
     * On success, `stat` MUST return exactly one result per reference, in the same order, however
     * many references it gets.
     */
    pub async fn stat(&self, references: &[ObjectRef]) -> Result<Vec<Result<Attr, Errno>>, Errno> {
        let mut results = Vec::with_capacity(references.len());
        for chunk in references.chunks(STAT_MAX_REFERENCES) {
            let response = self
                .client
                .clone()
                .stat(self.request(StatRequest {
                    object_ids: chunk.to_vec(),
                    include_metadata: None,
                }))
                .await?
                .into_inner();
            results.extend(attr_results(response, chunk.len())?);
        }
        Ok(results)
    }

    /// Finds each target's name in its parent directory, with the attributes of what it names.
    /**
     * @cc [owner:fontanierh,label:api] lookup-batch
     * On success, `lookup` MUST return exactly one result per target, in the same order, however
     * many targets it gets.
     */
    pub async fn lookup(
        &self,
        targets: &[LookupTarget],
    ) -> Result<Vec<Result<Attr, Errno>>, Errno> {
        let mut results = Vec::with_capacity(targets.len());
        for chunk in targets.chunks(LOOKUP_MAX_TARGETS) {
            let response = self
                .client
                .clone()
                .lookup(self.request(LookupRequest {
                    targets: chunk.to_vec(),
                    include_metadata: None,
                }))
                .await?
                .into_inner();
            results.extend(attr_results(response, chunk.len())?);
        }
        Ok(results)
    }

    /// Lists the entries of the directory `directory` the session can read, in the server's order.
    /// Each page is a separate request, so changes made to the directory while it is listed may or
    /// may not show.
    /**
     * @cc [owner:fontanierh,label:api] list-every-page
     * On success, `list` MUST return the entries of every page of `directory`, asking for the next
     * page until the server returns one without `next_after`. Any failed page MUST fail `list`.
     */
    pub async fn list(&self, directory: ObjectRef) -> Result<Vec<Entry>, Errno> {
        let mut entries = Vec::new();
        let mut after = None;
        loop {
            let page = self
                .client
                .clone()
                .list(self.request(ListRequest {
                    directory_id: directory,
                    after,
                    limit: LIST_MAX_ENTRIES,
                }))
                .await?
                .into_inner();
            entries.extend(page.entries);
            match page.next_after {
                Some(next_after) => after = Some(next_after),
                None => return Ok(entries),
            }
        }
    }

    /// Reads up to `length` bytes of the file `object` from `offset`, with its attributes. The data
    /// is shorter than `length` only at the end of the file. `length` is at most `READ_MAX_BYTES`.
    pub async fn read(
        &self,
        object: ObjectId,
        offset: u64,
        length: u32,
    ) -> Result<ReadData, Errno> {
        let response = self
            .client
            .clone()
            .read(self.request(ReadRequest {
                object_id: object,
                offset,
                length,
            }))
            .await?;
        Ok(response.into_inner())
    }
}

/// The results of a `Stat` or `Lookup` batch, one per request item. Fails with `EIO` if the server
/// returned another count or a result with both or neither of an attribute and an error.
fn attr_results(batch: AttrBatch, expected: usize) -> Result<Vec<Result<Attr, Errno>>, Errno> {
    if batch.results.len() != expected {
        return Err(Errno::EIO);
    }
    Ok(batch
        .results
        .into_iter()
        .map(|result| match (result.object, result.error) {
            (Some(attr), None) => Ok(attr),
            (None, Some(error)) => Err(error.code().into()),
            _ => Err(Errno::EIO),
        })
        .collect())
}
