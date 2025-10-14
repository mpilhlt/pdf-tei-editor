"""
Server-Sent Events (SSE) service for real-time progress updates.

Provides:
- Message queues per client for async event delivery
- Event stream generation for FastAPI StreamingResponse
- Thread-safe message delivery
- Automatic queue cleanup
"""

import queue
import threading
from typing import Dict, Generator, Optional
from datetime import datetime, timedelta


class SSEService:
    """
    Service for managing Server-Sent Events streams.

    Maintains message queues for each connected client and provides
    methods to send events and generate event streams.
    """

    def __init__(self, logger=None):
        """
        Initialize SSE service.

        Args:
            logger: Optional logger instance
        """
        self.logger = logger
        self.message_queues: Dict[str, queue.Queue] = {}
        self.queue_timestamps: Dict[str, datetime] = {}
        self.lock = threading.Lock()

        # Configuration
        self.queue_timeout = 0.5  # Seconds to wait for new messages
        self.max_queue_age = timedelta(hours=1)  # Max age before cleanup

    def create_queue(self, client_id: str) -> queue.Queue:
        """
        Create message queue for a client.

        Args:
            client_id: Unique client identifier (usually session ID)

        Returns:
            Message queue for the client
        """
        with self.lock:
            if client_id not in self.message_queues:
                self.message_queues[client_id] = queue.Queue()
                self.queue_timestamps[client_id] = datetime.now()

                if self.logger:
                    self.logger.debug(f"Created SSE queue for client: {client_id}")

            return self.message_queues[client_id]

    def remove_queue(self, client_id: str) -> None:
        """
        Remove message queue for a client.

        Args:
            client_id: Client identifier
        """
        with self.lock:
            if client_id in self.message_queues:
                del self.message_queues[client_id]
                del self.queue_timestamps[client_id]

                if self.logger:
                    self.logger.debug(f"Removed SSE queue for client: {client_id}")

    def send_message(
        self,
        client_id: str,
        event_type: str,
        data: str
    ) -> bool:
        """
        Send SSE message to a client.

        Args:
            client_id: Client identifier
            event_type: Event type (e.g., 'syncProgress', 'syncMessage')
            data: Event data (string)

        Returns:
            True if message was queued, False if queue doesn't exist
        """
        with self.lock:
            if client_id not in self.message_queues:
                if self.logger:
                    self.logger.warning(f"No SSE queue for client: {client_id}")
                return False

            try:
                self.message_queues[client_id].put({
                    'event': event_type,
                    'data': data
                }, block=False)

                if self.logger:
                    self.logger.debug(f"Sent SSE {event_type} to {client_id}: {data[:50]}")

                return True

            except queue.Full:
                if self.logger:
                    self.logger.error(f"SSE queue full for client: {client_id}")
                return False

    def event_stream(self, client_id: str) -> Generator[str, None, None]:
        """
        Generate SSE event stream for a client.

        This generator yields formatted SSE messages and should be used
        with FastAPI's StreamingResponse.

        Args:
            client_id: Client identifier

        Yields:
            Formatted SSE message strings
        """
        # Create queue if it doesn't exist
        msg_queue = self.create_queue(client_id)

        if self.logger:
            self.logger.info(f"Starting SSE stream for client: {client_id}")

        try:
            # Send initial connection event
            yield self._format_sse_message('connected', 'Stream connected')

            # Stream messages from queue
            while True:
                try:
                    # Wait for message with timeout
                    message = msg_queue.get(timeout=self.queue_timeout)

                    # Send the message
                    yield self._format_sse_message(
                        message['event'],
                        message['data']
                    )

                    # Send keep-alive comments periodically (every ~30s)
                    # This is handled by timeout - when no messages, send ping
                except queue.Empty:
                    # Send keep-alive ping
                    yield ': ping\n\n'
                    continue

        except GeneratorExit:
            if self.logger:
                self.logger.info(f"SSE stream closed for client: {client_id}")
        finally:
            # Clean up queue when stream ends
            self.remove_queue(client_id)

    def _format_sse_message(self, event: str, data: str) -> str:
        """
        Format message according to SSE protocol.

        Args:
            event: Event type
            data: Event data

        Returns:
            Formatted SSE message string
        """
        return f"event: {event}\ndata: {data}\n\n"

    def cleanup_stale_queues(self) -> int:
        """
        Remove stale message queues that haven't been accessed recently.

        Returns:
            Number of queues removed
        """
        with self.lock:
            now = datetime.now()
            stale_clients = []

            for client_id, timestamp in self.queue_timestamps.items():
                if now - timestamp > self.max_queue_age:
                    stale_clients.append(client_id)

            for client_id in stale_clients:
                del self.message_queues[client_id]
                del self.queue_timestamps[client_id]

                if self.logger:
                    self.logger.info(f"Cleaned up stale SSE queue: {client_id}")

            return len(stale_clients)

    def get_active_clients(self) -> list[str]:
        """
        Get list of currently active client IDs.

        Returns:
            List of client IDs with active queues
        """
        with self.lock:
            return list(self.message_queues.keys())
