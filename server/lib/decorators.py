from flask import request, jsonify, current_app
from functools import wraps
from server.lib.server_utils import ApiError
from httpx import ConnectTimeout, ReadTimeout
from webdav4.client import HTTPError

def handle_api_errors(f):
    """
    Decorator to handle API-specific and unexpected errors in API functions. If an (expected) API error is thrown,
    a HTTP 400 error is returned, otherwise a HTTP 500 error. 
    """
    @wraps(f)  # Preserves function metadata for debugging
    def decorated_function(*args, **kwargs):
        try:
            return f(*args, **kwargs) 
        except HTTPError as e:
            # WebDAV-specific connection problems raised as Timeout so that the client tries again
            current_app.logger.error(f"WebDAV connection problem: {str(e)}")
            return jsonify({"error": str(e)}), 504
            
        except ApiError as e:
            # Handle API-specific errors
            current_app.logger.warning(f"API Error: {str(e)}")
            return jsonify({"error": str(e)}), e.status_code or 400
        
        except (ConnectTimeout, ReadTimeout) as e:
            # Handle connection timeout errors specifically
            current_app.logger.error(f"Connection Timeout: {str(e)}")
            return jsonify({"error": str(e)}), 504

        except Exception as e:
            # Handle unexpected errors (all other exceptions)
            current_app.logger.exception(f"Unexpected Error: {str(e)}")
            return jsonify({"error": f"Internal Server Error: {str(e)}"}), 500

    return decorated_function

def session_required(f):
    """
    Decorator to ensure a session ID is present in the request header.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'X-Session-Id' not in request.headers:
            return jsonify(error="Access denied: session ID missing."), 403
        return f(*args, **kwargs)
    return decorated_function
