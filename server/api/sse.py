import time
import queue
from flask import Blueprint, Response, current_app, request
from server.lib.decorators import session_required
from server.lib.server_utils import get_session_id
from server.lib import auth

bp = Blueprint('sse', __name__, url_prefix='/sse')

# A simple in-memory message queue for each client
# In a production environment, you would use a more robust message queue like Redis
# This is a dictionary that will hold a queue for each client, identified by a unique ID
message_queues = {}

def event_stream(client_id, logger):
    """The generator for the SSE stream."""
    q = queue.Queue()
    message_queues[client_id] = q
    logger.info(f"Client {client_id} subscribed to SSE")
    try:
        # Send a welcome message
        yield "event: updateStatus\ndata: SSE connection established.\n\n"
        while True:
            # Wait for a message to be put into the queue
            event_type, data = q.get()
            if event_type is None: # A way to signal the end of the stream
                break
            # Format the message as a Server-Sent Event
            yield f"event: {event_type}\ndata: {data}\n\n"
    except GeneratorExit:
        # The client has disconnected
        logger.info(f"Client {client_id} disconnected from SSE")
    finally:
        # Clean up the message queue
        if client_id in message_queues:
            del message_queues[client_id]
            logger.info(f"Removed message queue for client {client_id}")

def send_sse_message(client_id, event_type, data):
    """
    Sends a message to a specific client via SSE.
    """
    if client_id in message_queues:
        message_queues[client_id].put((event_type, data))
        return True
    return False

@bp.route('/subscribe')
@session_required
def subscribe():
    session_id = get_session_id(request)
    user = auth.get_user_by_session_id(session_id)
    client_id = user.get('username')
    # We need to get a direct reference to the logger, because current_app is a proxy
    # that is only available in the request context.
    logger = current_app._get_current_object().logger
    return Response(event_stream(session_id, logger), mimetype='text/event-stream')

@bp.route('/test')
@session_required
def test_sse():
    session_id = get_session_id(request)
    user = auth.get_user_by_session_id(session_id)
    client_id = user.get('id', 'anonymous') if user else 'anonymous'
    if client_id not in message_queues:
        return "SSE not subscribed", 400
    
    def message_generator():
        q = message_queues[client_id]
        for i in range(10):
            message = f"The server time is {time.strftime('%H:%M:%S')}"
            q.put(("test", message))
            print(message)
            time.sleep(1)
        # No need to send an end signal here, the connection remains open
    
    from threading import Thread
    Thread(target=message_generator).start()
    
    return "Test started. Use sseObj.addEventListener('test', ...) to listen for events.", 200
