from flask import request, jsonify, current_app
from functools import wraps
from api.lib.server_utils import ApiError

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