"""
Base class for database migrations.

Each migration should:
1. Have a unique version number
2. Provide a description
3. Implement upgrade() and downgrade() methods
4. Be idempotent where possible
"""

import sqlite3
from abc import ABC, abstractmethod
from typing import Optional
import logging


class Migration(ABC):
    """
    Base class for database migrations.

    Subclasses must implement upgrade() and downgrade() methods.
    """

    def __init__(self, logger: Optional[logging.Logger] = None):
        """
        Initialize migration.

        Args:
            logger: Optional logger instance
        """
        self.logger = logger or logging.getLogger(__name__)

    @property
    @abstractmethod
    def version(self) -> int:
        """
        Migration version number.

        Must be unique and sequential (1, 2, 3, ...).
        """
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """
        Human-readable description of the migration.
        """
        pass

    @abstractmethod
    def upgrade(self, conn: sqlite3.Connection) -> None:
        """
        Apply the migration.

        Args:
            conn: SQLite connection (in transaction)

        Raises:
            Exception: If migration fails
        """
        pass

    @abstractmethod
    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Revert the migration.

        Args:
            conn: SQLite connection (in transaction)

        Raises:
            Exception: If rollback fails
        """
        pass

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """
        Check if migration can be applied.

        Override this to add pre-migration checks.

        Args:
            conn: SQLite connection

        Returns:
            True if migration can be applied
        """
        return True

    def __repr__(self) -> str:
        return f"<Migration {self.version}: {self.description}>"
