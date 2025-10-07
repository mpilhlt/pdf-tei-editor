import time
import queue
from flask import Blueprint, Response, current_app, request
from server.lib.decorators import session_required
from server.lib.server_utils import get_session_id
from server.lib import auth
import logging

logger = logging.getLogger(__name__)
bp = Blueprint('sse', __name__, url_prefix='/sse')

def event_stream(client_id, message_queues):
    """The generator for the SSE stream."""
    import threading
    #logger.debug(f"event_stream called with client_id='{client_id}'")
    #logger.debug(f"event_stream thread: {threading.current_thread().name} (ID: {threading.get_ident()})")
    #logger.debug(f"event_stream message_queues object ID: {id(message_queues)}")
    q = queue.Queue()
    message_queues[client_id] = q
    logger.debug(f"Created message queue for client_id='{client_id}'")
    #logger.debug(f"message_queues object ID: {id(message_queues)}")
    logger.debug(f"Available message queues: {list(message_queues.keys())}")
    
    logger.info(f"Client {client_id} subscribed to SSE")
    try:
        # Send a welcome message
        yield "event: updateStatus\ndata: SSE connection established.\n\n"
        while True:
            try:
                # Wait for a message with timeout to allow keep-alive
                event_type, data = q.get(timeout=30)
                if event_type is None: # A way to signal the end of the stream
                    logger.debug(f"Received end signal for client {client_id}")
                    break
                # Format the message as a Server-Sent Event
                logger.debug(f"Sending SSE message to client {client_id}: {event_type} = {data}")
                yield f"event: {event_type}\ndata: {data}\n\n"
            except queue.Empty:
                # Send keep-alive message to prevent connection timeout
                logger.debug(f"Sending keep-alive to client {client_id}")
                yield ": keep-alive\n\n"
    except GeneratorExit:
        # The client has disconnected
        logger.debug(f"Client {client_id} disconnected (GeneratorExit)")
        logger.info(f"Client {client_id} disconnected from SSE")
    except Exception as e:
        # Any other exception
        logger.debug(f"Client {client_id} disconnected due to exception: {type(e).__name__}: {e}")
        logger.error(f"Client {client_id} SSE stream error: {type(e).__name__}: {e}")
    finally:
        # Clean up the message queue
        logger.debug(f"Cleaning up message queue for client_id='{client_id}'")
        logger.debug(f"Message queues before cleanup: {list(message_queues.keys())}")
        if client_id in message_queues:
            del message_queues[client_id]
            logger.debug(f"Removed message queue for client {client_id}")
            logger.info(f"Removed message queue for client {client_id}")
        else:
            logger.debug(f"No message queue found for client {client_id} during cleanup")
        logger.debug(f"Message queues after cleanup: {list(message_queues.keys())}")

def send_sse_message(client_id, event_type, data):
    """
    Sends a message to a specific client via SSE.
    """
    import threading
    message_queues = current_app.message_queues
    logger.debug(f"send_sse_message called - client_id='{client_id}', event_type='{event_type}', data='{data}'")
    #logger.debug(f"Current thread: {threading.current_thread().name} (ID: {threading.get_ident()})")
    #logger.debug(f"message_queues object ID: {id(message_queues)}")
    #logger.debug(f"Available message queues: {list(message_queues.keys())}")
    #logger.debug(f"Total message queues count: {len(message_queues)}")
    
    if not client_id or client_id == "":
        logger.error("No client id given")
        raise RuntimeError("No client id given")
    
    if client_id in message_queues:
        message_queues[client_id].put((event_type, data))
        logger.debug(f"Sent event of type {event_type} with data '{data}' to client with id '{client_id}'")
        return True
    else:
        # Client not connected to SSE - this is normal, just debug log it
        logger.debug(f"Client ID '{client_id}' not found in message queues (client not connected to SSE)")
        logger.debug(f"Available message queues: {list(message_queues.keys())}")
        return False

@bp.route('/subscribe')
@session_required
def subscribe():
    session_id = get_session_id(request)
    user = auth.get_user_by_session_id(session_id)
    client_id = user.get('username')
    logger.debug(f"SSE /subscribe called - session_id='{session_id}', user='{client_id}'")
    logger.debug(f"Using session_id='{session_id}' as client_id for message queue")
    logger.debug(f"Current message queues before subscribe: {list(current_app.message_queues.keys())}")
    logger.debug(f"Request headers: {dict(request.headers)}")
    logger.debug(f"Request remote_addr: {request.remote_addr}")
    
    return Response(event_stream(session_id, current_app.message_queues), mimetype='text/event-stream')

@bp.route('/test')
@session_required
def test_sse():
    session_id = get_session_id(request)
    if session_id not in current_app.message_queues:
        return "SSE not subscribed", 400
    
    def message_generator():
        q = current_app.message_queues[session_id]
        for i in range(10):
            message = f"The server time is {time.strftime('%H:%M:%S')}"
            q.put(("test", message))
            logger.debug(message)
            time.sleep(1)
        # No need to send an end signal here, the connection remains open
    
    from threading import Thread
    Thread(target=message_generator).start()
    
    return "Test started. Use sseObj.addEventListener('test', ...) to listen for events.", 200

@bp.route('/test-sync')
@session_required
def test_sync_messages():
    session_id = get_session_id(request)
    if session_id not in current_app.message_queues:
        return "SSE not subscribed", 400
    
    def sync_message_generator():
        q = current_app.message_queues[session_id]
        # Test sync progress messages
        for i in range(0, 101, 20):
            q.put(("syncProgress", str(i)))
            time.sleep(0.5)
        
        # Test sync messages
        messages = [
            "Starting synchronization...",
            "Found 5 local files",
            "Found 3 remote files", 
            "Uploading file.xml",
            "Synchronization completed successfully"
        ]
        
        for msg in messages:
            q.put(("syncMessage", msg))
            time.sleep(1)
    
    from threading import Thread
    Thread(target=sync_message_generator).start()
    
    return "Sync message test started. Check console for syncProgress and syncMessage events.", 200
