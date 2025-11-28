# WebDAV-based synchronization

The PDF and XML files that have been uploaded, generated, and edited with this application can be synchronized with a WebDAV server. This is useful as a backup (especially if the WebDAV server provides versioning) and if several instances of the application share a common repository. 

The WebDAV server is configured via environment variables - see [](https://github.com/mpilhlt/pdf-tei-editor/blob/1c971acc2ff770288a05155242a5ccc50d68b5dd/.env.dist#L12).

It automatically starts a synchronization after changes in the filesystem. 