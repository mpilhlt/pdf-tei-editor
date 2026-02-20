"""Event bus for loose coupling between plugins and application components.

This module provides a lightweight event emitter/observer pattern implementation
using Python's built-in asyncio for async event handling.

Example:
    ```python
    from fastapi_app.lib.event_bus import get_event_bus

    # Register a handler
    bus = get_event_bus()

    async def on_file_updated(file_id: str, variant: str, **kwargs):
        print(f"File {file_id} ({variant}) was updated")

    bus.on("file.updated", on_file_updated)

    # Emit an event
    await bus.emit("file.updated", file_id="abc123", variant="tei")
    ```
"""

from typing import Callable, Dict, List
import asyncio
import logging

logger = logging.getLogger(__name__)


class EventBus:
    """Lightweight event bus for decoupled communication between components.

    Supports async event handlers and automatic error isolation (exceptions in
    one handler don't affect others).
    """

    def __init__(self):
        """Initialize the event bus with an empty handler registry."""
        self._handlers: Dict[str, List[Callable]] = {}

    def on(self, event_name: str, handler: Callable):
        """Register an event handler for a specific event.

        Args:
            event_name: Name of the event to listen for (e.g., "file.updated")
            handler: Async function to call when event is emitted. Should accept
                    **kwargs matching the event payload.
        """
        if event_name not in self._handlers:
            self._handlers[event_name] = []
        self._handlers[event_name].append(handler)
        logger.debug(f"Registered handler for event '{event_name}'")

    def off(self, event_name: str, handler: Callable):
        """Unregister a specific event handler.

        Args:
            event_name: Name of the event
            handler: The handler function to remove
        """
        if event_name in self._handlers:
            try:
                self._handlers[event_name].remove(handler)
                logger.debug(f"Unregistered handler for event '{event_name}'")
            except ValueError:
                logger.warning(f"Handler not found for event '{event_name}'")

    async def emit(self, event_name: str, **kwargs):
        """Emit an event to all registered handlers (fire-and-forget).

        Handlers are called asynchronously in the background. This method returns
        immediately without waiting for handlers to complete. Exceptions in handlers
        are logged but don't affect the caller.

        This fire-and-forget approach prevents database access race conditions when
        event handlers query the database during operations that are already using
        database connections.

        Args:
            event_name: Name of the event to emit
            **kwargs: Event payload passed to all handlers
        """
        
        if event_name not in self._handlers:
            logger.debug(f"No handlers registered for event '{event_name}'")
            return

        logger.debug(f"Emitting event '{event_name}' to {len(self._handlers[event_name])} handler(s)")

        # Create background task for handler execution (fire-and-forget)
        async def run_handlers():
            """Execute all handlers and log any exceptions."""
            tasks = [handler(**kwargs) for handler in self._handlers[event_name]]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            # Log any exceptions from handlers
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    handler = self._handlers[event_name][i]
                    logger.error(
                        f"Error in handler {handler.__name__} for event '{event_name}': {result}",
                        exc_info=result
                    )

        # Launch handlers in background without awaiting
        asyncio.create_task(run_handlers())


# Singleton instance
_event_bus = None


def get_event_bus() -> EventBus:
    """Get the singleton event bus instance.

    Returns:
        EventBus: The application-wide event bus instance
    """
    global _event_bus
    if _event_bus is None:
        _event_bus = EventBus()
        logger.debug("Initialized event bus")
    return _event_bus
