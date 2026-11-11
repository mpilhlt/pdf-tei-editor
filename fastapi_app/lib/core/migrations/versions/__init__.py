"""
Database migration versions.

Each migration should be a separate file in this directory.

Migrations are organized by target database to avoid unnecessary checks
and log noise when running migrations on specific databases.
"""

from .m001_locks_file_id import Migration001LocksFileId
from .m002_sync_tei_collections import Migration002SyncTeiCollections
from .m003_remove_schema_files import Migration003RemoveSchemaFiles
from .m004_encode_pdf_doc_ids import Migration004EncodePdfDocIds
from .m005_add_status_column import Migration005AddStatusColumn
from .m006_add_last_revision_column import Migration006AddLastRevisionColumn
from .m007_add_created_by_column import Migration007AddCreatedByColumn
from .m008_change_primary_key import Migration008ChangePrimaryKey
from .m009_document_rules_tables import Migration009DocumentRulesTables
from .m010_add_parent_stable_id_column import Migration010AddParentStableIdColumn
from .m011_document_rules_section_overrides import Migration011DocumentRulesSectionOverrides
from .m012_sessions_token_columns import Migration012SessionsTokenColumns
from .m013_sessions_launch_tokens import Migration013SessionsLaunchTokens

# Migrations by target database
LOCKS_MIGRATIONS = [
    Migration001LocksFileId,
]

METADATA_MIGRATIONS = [
    Migration002SyncTeiCollections,
    Migration003RemoveSchemaFiles,
    Migration004EncodePdfDocIds,
    Migration005AddStatusColumn,
    Migration006AddLastRevisionColumn,
    Migration007AddCreatedByColumn,
    Migration008ChangePrimaryKey,
    Migration009DocumentRulesTables,
    Migration010AddParentStableIdColumn,
    Migration011DocumentRulesSectionOverrides,
]

SESSIONS_MIGRATIONS = [
    Migration012SessionsTokenColumns,
    Migration013SessionsLaunchTokens,
]

# Access tokens database migrations (for future schema changes)
# Base schema is created by AccessTokenStore in access_tokens.py
ACCESS_TOKENS_MIGRATIONS = []

# Permissions database migrations (for future schema changes)
# Base schema is created by initialize_permissions_schema() in permissions_db.py
PERMISSIONS_MIGRATIONS = []

# All migrations in order (for tools that need the complete list)
ALL_MIGRATIONS = [
    Migration001LocksFileId,
    Migration002SyncTeiCollections,
    Migration003RemoveSchemaFiles,
    Migration004EncodePdfDocIds,
    Migration005AddStatusColumn,
    Migration006AddLastRevisionColumn,
    Migration007AddCreatedByColumn,
    Migration008ChangePrimaryKey,
    Migration009DocumentRulesTables,
    Migration010AddParentStableIdColumn,
    Migration011DocumentRulesSectionOverrides,
    Migration012SessionsTokenColumns,
    Migration013SessionsLaunchTokens,
]

__all__ = [
    "ACCESS_TOKENS_MIGRATIONS",
    "ALL_MIGRATIONS",
    "LOCKS_MIGRATIONS",
    "METADATA_MIGRATIONS",
    "PERMISSIONS_MIGRATIONS",
    "SESSIONS_MIGRATIONS",
]

