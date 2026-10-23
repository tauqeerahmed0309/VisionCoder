class APIError(Exception):
    def __init__(self, status_code: int, code: str, message: str, headers: dict[str, str] | None = None):
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers or {}
        super().__init__(message)


class ModelConfigurationError(Exception):
    pass


class ModelTimeoutError(Exception):
    pass


class ModelProviderError(Exception):
    """The model provider call failed.

    ``public_message`` is safe to show to the user. The raw provider error is
    only ever written to the server log (with the API key redacted).
    """

    def __init__(
        self,
        message: str,
        *,
        public_message: str | None = None,
        http_status: int = 502,
        code: str = "MODEL_ERROR",
        retryable: bool = False,
        retry_after: int | None = None,
    ):
        super().__init__(message)
        self.retryable = retryable
        self.retry_after = retry_after
        self.public_message = public_message or "The model provider request failed. Please try again."
        self.http_status = http_status
        self.code = code


class InvalidModelOutputError(Exception):
    pass


class ServerBusyError(Exception):
    """Too many pages are being generated at once and no slot freed up in time."""
