from flask import request, jsonify, current_app
from functools import wraps
from lib.server_utils import ApiError

def allow_only_secure_hosts(f):
    def decorated_function(*args, **kwargs):
        target_host = request.headers.get('X-Forwarded-Host') or request.host
        target_host = target_host.split(":")[0]
        if target_host != 'localhost':
            return jsonify({"error": f'Access denied from {target_host}. Only localhost is allowed.'}), 403
        return f(*args, **kwargs)
    decorated_function.__name__ = f.__name__ # Preserve original function name for debugging
    return decorated_function


def handle_api_errors(f):
    """
    Decorator to handle API-specific and unexpected errors in API functions. If an (expected) API error is thrown,
    a HTTP 400 error is returned, otherwise a HTTP 500 error. 
    """
    @wraps(f)  # Preserves function metadata for debugging
    def decorated_function(*args, **kwargs):
        try:
            return f(*args, **kwargs)  # Execute the decorated function
        except ApiError as e:
            # Handle API-specific errors
            current_app.logger.warning(f"API Error: {str(e)}")
            return jsonify({"error": str(e)}), 400  

        except Exception as e:
            # Handle unexpected errors (all other exceptions)
            current_app.logger.exception(f"Unexpected Error: {str(e)}")
            return jsonify({"error": f"Internal Server Error: {str(e)}"}), 500

    return decorated_function