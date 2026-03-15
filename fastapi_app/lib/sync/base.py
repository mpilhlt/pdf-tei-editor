"""Abstract base class for synchronization services."""

from abc import ABC, abstractmethod
from typing import Optional

from .models import SyncSummary, SyncStatusResponse, ConflictListResponse, ConflictResolution


class SyncServiceBase(ABC):
    """
    Abstract base class for sync implementations.

    Sync plugins implement this interface to provide synchronization
    with various backends (WebDAV, Git, cloud storage, etc.).

    SSE Events emitted during perform_sync():
        syncProgress: int (0-100) — progress percentage
        syncMessage: str — status message for user
    """

    @abstractmethod
    def check_status(self) -> SyncStatusResponse:
        """
        Check if synchronization is needed.

        Returns:
            SyncStatusResponse with sync status details
        """

    @abstractmethod
    def perform_sync(
        self,
        client_id: Optional[str] = None,
        force: bool = False
    ) -> SyncSummary:
        """
        Perform synchronization.

        Args:
            client_id: Client ID for SSE progress updates
            force: Force sync even if not needed

        Returns:
            SyncSummary with operation results
        """

    @abstractmethod
    def get_conflicts(self) -> ConflictListResponse:
        """
        Get list of sync conflicts.

        Returns:
            ConflictListResponse with conflict details
        """

    @abstractmethod
    def resolve_conflict(self, resolution: ConflictResolution) -> dict:
        """
        Resolve a sync conflict.

        Args:
            resolution: Resolution strategy

        Returns:
            Dict with result message
        """
