"""Unit tests for the event bus module."""

import unittest
import asyncio
from unittest.mock import AsyncMock, MagicMock
from fastapi_app.lib.event_bus import EventBus, get_event_bus


class TestEventBus(unittest.TestCase):
    """Test cases for EventBus class."""

    def setUp(self):
        """Create a fresh EventBus instance for each test."""
        self.bus = EventBus()

    def test_on_registers_handler(self):
        """Test that on() registers a handler for an event."""
        handler = AsyncMock()
        self.bus.on("test.event", handler)

        self.assertIn("test.event", self.bus._handlers)
        self.assertIn(handler, self.bus._handlers["test.event"])

    def test_on_registers_multiple_handlers(self):
        """Test that multiple handlers can be registered for the same event."""
        handler1 = AsyncMock()
        handler2 = AsyncMock()

        self.bus.on("test.event", handler1)
        self.bus.on("test.event", handler2)

        self.assertEqual(len(self.bus._handlers["test.event"]), 2)
        self.assertIn(handler1, self.bus._handlers["test.event"])
        self.assertIn(handler2, self.bus._handlers["test.event"])

    def test_off_unregisters_handler(self):
        """Test that off() removes a registered handler."""
        handler = AsyncMock()
        self.bus.on("test.event", handler)
        self.bus.off("test.event", handler)

        self.assertEqual(len(self.bus._handlers["test.event"]), 0)

    def test_off_nonexistent_handler(self):
        """Test that off() handles removal of non-existent handler gracefully."""
        handler = AsyncMock()
        # Should not raise exception
        self.bus.off("test.event", handler)

    async def test_emit_calls_handlers(self):
        """Test that emit() calls all registered handlers with correct arguments."""
        handler1 = AsyncMock()
        handler2 = AsyncMock()

        self.bus.on("test.event", handler1)
        self.bus.on("test.event", handler2)

        await self.bus.emit("test.event", arg1="value1", arg2="value2")

        handler1.assert_called_once_with(arg1="value1", arg2="value2")
        handler2.assert_called_once_with(arg1="value1", arg2="value2")

    async def test_emit_no_handlers(self):
        """Test that emit() handles events with no registered handlers gracefully."""
        # Should not raise exception
        await self.bus.emit("nonexistent.event", arg="value")

    async def test_emit_handler_exception_isolation(self):
        """Test that exceptions in one handler don't affect other handlers."""
        handler1 = AsyncMock(side_effect=ValueError("Handler 1 failed"))
        handler2 = AsyncMock()
        handler3 = AsyncMock()

        self.bus.on("test.event", handler1)
        self.bus.on("test.event", handler2)
        self.bus.on("test.event", handler3)

        # Should not raise exception
        await self.bus.emit("test.event", arg="value")

        # All handlers should have been called despite handler1 failing
        handler1.assert_called_once_with(arg="value")
        handler2.assert_called_once_with(arg="value")
        handler3.assert_called_once_with(arg="value")

    async def test_emit_concurrent_execution(self):
        """Test that handlers are executed concurrently."""
        execution_order = []

        async def handler1(**kwargs):
            execution_order.append("handler1_start")
            await asyncio.sleep(0.1)
            execution_order.append("handler1_end")

        async def handler2(**kwargs):
            execution_order.append("handler2_start")
            await asyncio.sleep(0.05)
            execution_order.append("handler2_end")

        self.bus.on("test.event", handler1)
        self.bus.on("test.event", handler2)

        await self.bus.emit("test.event")

        # If concurrent, handler2 should finish before handler1
        self.assertEqual(execution_order[0], "handler1_start")
        self.assertEqual(execution_order[1], "handler2_start")
        self.assertEqual(execution_order[2], "handler2_end")
        self.assertEqual(execution_order[3], "handler1_end")

    async def test_multiple_events(self):
        """Test that different events maintain separate handler lists."""
        handler1 = AsyncMock()
        handler2 = AsyncMock()

        self.bus.on("event.one", handler1)
        self.bus.on("event.two", handler2)

        await self.bus.emit("event.one", arg="value1")
        await self.bus.emit("event.two", arg="value2")

        handler1.assert_called_once_with(arg="value1")
        handler2.assert_called_once_with(arg="value2")


class TestGetEventBus(unittest.TestCase):
    """Test cases for get_event_bus singleton."""

    def test_get_event_bus_returns_instance(self):
        """Test that get_event_bus() returns an EventBus instance."""
        bus = get_event_bus()
        self.assertIsInstance(bus, EventBus)

    def test_get_event_bus_singleton(self):
        """Test that get_event_bus() returns the same instance."""
        bus1 = get_event_bus()
        bus2 = get_event_bus()
        self.assertIs(bus1, bus2)


class TestEventBusIntegration(unittest.TestCase):
    """Integration tests demonstrating real-world usage patterns."""

    def setUp(self):
        """Create a fresh EventBus instance for each test."""
        self.bus = EventBus()

    async def test_file_update_scenario(self):
        """Test a realistic file update event scenario."""
        results = []

        async def cache_invalidator(file_id: str, variant: str, **kwargs):
            results.append(f"cache_invalidated:{file_id}:{variant}")

        async def notification_sender(file_id: str, variant: str, **kwargs):
            results.append(f"notification_sent:{file_id}:{variant}")

        async def index_updater(file_id: str, variant: str, **kwargs):
            results.append(f"index_updated:{file_id}:{variant}")

        self.bus.on("file.updated", cache_invalidator)
        self.bus.on("file.updated", notification_sender)
        self.bus.on("file.updated", index_updater)

        await self.bus.emit("file.updated", file_id="abc123", variant="tei")

        self.assertEqual(len(results), 3)
        self.assertIn("cache_invalidated:abc123:tei", results)
        self.assertIn("notification_sent:abc123:tei", results)
        self.assertIn("index_updated:abc123:tei", results)

    async def test_plugin_lifecycle_scenario(self):
        """Test plugin registration and cleanup scenario."""
        results = []

        async def plugin_handler(action: str, **kwargs):
            results.append(action)

        # Plugin registers
        self.bus.on("plugin.lifecycle", plugin_handler)
        await self.bus.emit("plugin.lifecycle", action="initialized")

        # Plugin unregisters
        self.bus.off("plugin.lifecycle", plugin_handler)
        await self.bus.emit("plugin.lifecycle", action="shutdown")

        # Only the first event should have been processed
        self.assertEqual(results, ["initialized"])


def run_async_test(coro):
    """Helper to run async test methods."""
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(coro)


# Make async tests work with unittest
for name, method in list(TestEventBus.__dict__.items()):
    if name.startswith("test_") and asyncio.iscoroutinefunction(method):
        setattr(TestEventBus, name, lambda self, m=method: run_async_test(m(self)))

for name, method in list(TestEventBusIntegration.__dict__.items()):
    if name.startswith("test_") and asyncio.iscoroutinefunction(method):
        setattr(TestEventBusIntegration, name, lambda self, m=method: run_async_test(m(self)))


if __name__ == "__main__":
    unittest.main()
