"""
Unit tests for SSEService (Phase 6).

Tests:
- Queue creation and removal
- Message sending
- Event stream generation
- SSE message formatting
- Queue cleanup
- Thread safety
- Keep-alive pings

@testCovers fastapi_app/lib/sse_service.py
"""

import unittest
import queue
import time
from unittest.mock import Mock
from datetime import datetime, timedelta

from fastapi_app.lib.sse_service import SSEService


class TestSSEService(unittest.TestCase):
    """Test SSEService operations."""

    def setUp(self):
        """Set up test environment."""
        self.logger = Mock()
        self.service = SSEService(self.logger)

    def test_initialization(self):
        """Test service initialization."""
        self.assertIsNotNone(self.service.message_queues)
        self.assertIsNotNone(self.service.queue_timestamps)
        self.assertIsNotNone(self.service.lock)
        self.assertEqual(self.service.queue_timeout, 0.5)
        self.assertIsInstance(self.service.max_queue_age, timedelta)

    def test_create_queue(self):
        """Test creating message queue for a client."""
        client_id = 'test_client_123'

        # Create queue
        msg_queue = self.service.create_queue(client_id)

        # Verify queue was created
        self.assertIsInstance(msg_queue, queue.Queue)
        self.assertIn(client_id, self.service.message_queues)
        self.assertIn(client_id, self.service.queue_timestamps)

        # Verify logger was called
        self.logger.debug.assert_called()

        # Creating same queue again should return existing queue
        same_queue = self.service.create_queue(client_id)
        self.assertIs(same_queue, msg_queue)

    def test_remove_queue(self):
        """Test removing message queue."""
        client_id = 'test_client_123'

        # Create and remove queue
        self.service.create_queue(client_id)
        self.service.remove_queue(client_id)

        # Verify queue was removed
        self.assertNotIn(client_id, self.service.message_queues)
        self.assertNotIn(client_id, self.service.queue_timestamps)

        # Removing non-existent queue should not error
        self.service.remove_queue('nonexistent_client')

    def test_send_message_success(self):
        """Test sending message to existing queue."""
        client_id = 'test_client_123'
        self.service.create_queue(client_id)

        # Send message
        result = self.service.send_message(
            client_id,
            'syncProgress',
            '50'
        )

        # Verify success
        self.assertTrue(result)

        # Verify message was queued
        msg_queue = self.service.message_queues[client_id]
        message = msg_queue.get_nowait()
        self.assertEqual(message['event'], 'syncProgress')
        self.assertEqual(message['data'], '50')

    def test_send_message_to_nonexistent_queue(self):
        """Test sending message to non-existent queue."""
        result = self.service.send_message(
            'nonexistent_client',
            'syncProgress',
            '50'
        )

        # Should return False
        self.assertFalse(result)
        self.logger.warning.assert_called()

    def test_send_multiple_messages(self):
        """Test sending multiple messages."""
        client_id = 'test_client_123'
        self.service.create_queue(client_id)

        # Send multiple messages
        messages = [
            ('syncProgress', '10'),
            ('syncMessage', 'Starting sync...'),
            ('syncProgress', '50'),
            ('syncMessage', 'Uploading files...'),
            ('syncProgress', '100')
        ]

        for event, data in messages:
            result = self.service.send_message(client_id, event, data)
            self.assertTrue(result)

        # Verify all messages are in queue
        msg_queue = self.service.message_queues[client_id]
        self.assertEqual(msg_queue.qsize(), 5)

    def test_format_sse_message(self):
        """Test SSE message formatting."""
        # Test simple message
        formatted = self.service._format_sse_message('testEvent', 'test data')
        self.assertEqual(formatted, 'event: testEvent\ndata: test data\n\n')

        # Test with special characters
        formatted = self.service._format_sse_message('progress', '50%')
        self.assertEqual(formatted, 'event: progress\ndata: 50%\n\n')

        # Test with JSON-like data
        formatted = self.service._format_sse_message(
            'update',
            '{"status": "complete", "count": 42}'
        )
        expected = 'event: update\ndata: {"status": "complete", "count": 42}\n\n'
        self.assertEqual(formatted, expected)

    def test_event_stream_generator(self):
        """Test event stream generation."""
        client_id = 'test_client_123'

        # Create generator
        stream = self.service.event_stream(client_id)

        # First message should be connection confirmation
        first_msg = next(stream)
        self.assertIn('event: connected', first_msg)
        self.assertIn('data: Stream connected', first_msg)

        # Send some messages
        self.service.send_message(client_id, 'testEvent', 'test data')
        self.service.send_message(client_id, 'progress', '50')

        # Get messages from stream
        msg1 = next(stream)
        self.assertIn('event: testEvent', msg1)
        self.assertIn('data: test data', msg1)

        msg2 = next(stream)
        self.assertIn('event: progress', msg2)
        self.assertIn('data: 50', msg2)

    def test_event_stream_keep_alive(self):
        """Test that stream sends keep-alive pings when no messages."""
        client_id = 'test_client_123'

        # Set a very short timeout for testing
        self.service.queue_timeout = 0.1

        # Create generator
        stream = self.service.event_stream(client_id)

        # Skip connection message
        next(stream)

        # Wait for keep-alive (should timeout and send ping)
        start_time = time.time()
        ping_msg = next(stream)
        elapsed = time.time() - start_time

        # Should be a ping
        self.assertEqual(ping_msg, ': ping\n\n')

        # Should have waited approximately queue_timeout
        self.assertGreater(elapsed, 0.05)
        self.assertLess(elapsed, 0.5)

    def test_event_stream_cleanup(self):
        """Test that stream cleans up queue when closed."""
        client_id = 'test_client_123'

        # Create generator
        stream = self.service.event_stream(client_id)

        # Start stream
        next(stream)

        # Verify queue exists
        self.assertIn(client_id, self.service.message_queues)

        # Close stream
        try:
            stream.close()
        except StopIteration:
            pass

        # Verify queue was removed
        self.assertNotIn(client_id, self.service.message_queues)

    def test_get_active_clients(self):
        """Test getting list of active clients."""
        # Initially empty
        clients = self.service.get_active_clients()
        self.assertEqual(len(clients), 0)

        # Create some queues
        self.service.create_queue('client1')
        self.service.create_queue('client2')
        self.service.create_queue('client3')

        # Verify all clients are listed
        clients = self.service.get_active_clients()
        self.assertEqual(len(clients), 3)
        self.assertIn('client1', clients)
        self.assertIn('client2', clients)
        self.assertIn('client3', clients)

        # Remove one client
        self.service.remove_queue('client2')

        # Verify updated list
        clients = self.service.get_active_clients()
        self.assertEqual(len(clients), 2)
        self.assertNotIn('client2', clients)

    def test_cleanup_stale_queues(self):
        """Test cleanup of stale queues."""
        # Create some queues
        self.service.create_queue('client1')
        self.service.create_queue('client2')
        self.service.create_queue('client3')

        # Make client1 and client2 stale
        old_time = datetime.now() - timedelta(hours=2)
        self.service.queue_timestamps['client1'] = old_time
        self.service.queue_timestamps['client2'] = old_time

        # Run cleanup
        removed_count = self.service.cleanup_stale_queues()

        # Verify stale queues were removed
        self.assertEqual(removed_count, 2)
        self.assertNotIn('client1', self.service.message_queues)
        self.assertNotIn('client2', self.service.message_queues)
        self.assertIn('client3', self.service.message_queues)

    def test_cleanup_no_stale_queues(self):
        """Test cleanup when no queues are stale."""
        # Create some queues
        self.service.create_queue('client1')
        self.service.create_queue('client2')

        # Run cleanup
        removed_count = self.service.cleanup_stale_queues()

        # No queues should be removed
        self.assertEqual(removed_count, 0)
        self.assertEqual(len(self.service.message_queues), 2)

    def test_thread_safety(self):
        """Test that operations are thread-safe."""
        import threading

        client_id = 'test_client'
        self.service.create_queue(client_id)

        # Track results
        results = []

        def send_messages(count):
            """Send multiple messages from a thread."""
            for i in range(count):
                result = self.service.send_message(
                    client_id,
                    'test',
                    f'message_{i}'
                )
                results.append(result)

        # Create multiple threads sending messages
        threads = []
        for _ in range(5):
            thread = threading.Thread(target=send_messages, args=(10,))
            threads.append(thread)
            thread.start()

        # Wait for all threads
        for thread in threads:
            thread.join()

        # Verify all messages were sent successfully
        self.assertEqual(len(results), 50)
        self.assertTrue(all(results))

        # Verify all messages are in queue
        msg_queue = self.service.message_queues[client_id]
        self.assertEqual(msg_queue.qsize(), 50)

    def test_multiple_clients(self):
        """Test handling multiple clients simultaneously."""
        clients = ['client1', 'client2', 'client3']

        # Create queues for all clients
        for client_id in clients:
            self.service.create_queue(client_id)

        # Send different messages to each client
        self.service.send_message('client1', 'event1', 'data1')
        self.service.send_message('client2', 'event2', 'data2')
        self.service.send_message('client3', 'event3', 'data3')

        # Verify each client has their own message
        msg1 = self.service.message_queues['client1'].get_nowait()
        self.assertEqual(msg1['event'], 'event1')
        self.assertEqual(msg1['data'], 'data1')

        msg2 = self.service.message_queues['client2'].get_nowait()
        self.assertEqual(msg2['event'], 'event2')
        self.assertEqual(msg2['data'], 'data2')

        msg3 = self.service.message_queues['client3'].get_nowait()
        self.assertEqual(msg3['event'], 'event3')
        self.assertEqual(msg3['data'], 'data3')

        # Verify queues are now empty
        self.assertTrue(self.service.message_queues['client1'].empty())
        self.assertTrue(self.service.message_queues['client2'].empty())
        self.assertTrue(self.service.message_queues['client3'].empty())

    def test_message_ordering(self):
        """Test that messages maintain order."""
        client_id = 'test_client'
        self.service.create_queue(client_id)

        # Send messages in specific order
        for i in range(10):
            self.service.send_message(client_id, 'order', str(i))

        # Retrieve and verify order
        msg_queue = self.service.message_queues[client_id]
        for i in range(10):
            msg = msg_queue.get_nowait()
            self.assertEqual(msg['data'], str(i))


if __name__ == '__main__':
    unittest.main()
