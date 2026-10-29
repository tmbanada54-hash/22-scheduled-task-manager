"""Bound JSON request bodies even when Content-Length is absent."""

from starlette.responses import JSONResponse


class RequestSizeLimitMiddleware:
    def __init__(self, app, max_bytes: int = 131072):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def too_large():
            response = JSONResponse({"detail": "Request body is too large"}, status_code=413)
            await response(scope, receive, send)

        for name, value in scope.get("headers", []):
            if name.lower() == b"content-length":
                try:
                    if int(value) > self.max_bytes:
                        await too_large()
                        return
                except ValueError:
                    pass

        messages = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            messages.append(message)
            total += len(message.get("body", b""))
            if total > self.max_bytes:
                await too_large()
                return
            if not message.get("more_body", False):
                break

        async def replay():
            if messages:
                return messages.pop(0)
            return await receive()

        await self.app(scope, replay, send)
