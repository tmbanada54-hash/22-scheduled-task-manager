"""Target URL validation and outbound network policy."""

import ipaddress
import re
from urllib.parse import urlsplit

from yarl import URL

from .config import Settings

_HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def normalize_host(host: str) -> str:
    if not host or "%" in host:
        raise ValueError("Invalid or scoped target hostname")
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    try:
        # Use the same IDNA normalization as aiohttp/yarl. Python's built-in
        # IDNA codec differs for names such as faß.de and can defeat allowlists.
        normalized = URL.build(scheme="http", host=host.rstrip(".")).raw_host
        if normalized is None:
            raise ValueError("Invalid target hostname")
        normalized = normalized.lower()
    except (UnicodeError, ValueError) as exc:
        raise ValueError("Invalid target hostname") from exc
    if len(normalized) > 253 or not normalized:
        raise ValueError("Invalid target hostname")
    if any(not _HOST_LABEL.fullmatch(label) for label in normalized.split(".")):
        raise ValueError("Invalid target hostname")
    return normalized


def parse_target_url(value: str) -> tuple[str, str]:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise ValueError("Target URL must be between 1 and 2048 characters")
    if any(ord(char) < 33 or ord(char) == 127 for char in value) or "\\" in value:
        raise ValueError("Target URL must not contain whitespace or control characters")
    try:
        parts = urlsplit(value)
        if parts.scheme.lower() not in {"http", "https"} or not parts.netloc or not parts.hostname:
            raise ValueError("Target URL must use http or https and include a hostname")
        if parts.username is not None or parts.password is not None:
            raise ValueError("Credentials in target URLs are not allowed; use headers instead")
        if parts.fragment:
            raise ValueError("Target URLs must not contain a fragment")
        # Accessing port validates it (including range) and catches malformed IPv6.
        port = parts.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("Invalid target port")
        host = normalize_host(parts.hostname)
        actual_host = URL(value).raw_host
        if actual_host is None or normalize_host(actual_host) != host:
            raise ValueError("Ambiguous target hostname")
    except (UnicodeError, ValueError) as exc:
        raise ValueError(str(exc)) from exc
    return parts.scheme.lower(), host


def is_public_address(value: str) -> bool:
    address = ipaddress.ip_address(value.split("%", 1)[0])
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.is_global and not address.is_multicast


class TargetPolicy:
    def __init__(self, settings: Settings):
        self.allow_private = settings.allow_private_targets
        self.allowed_hosts = frozenset(normalize_host(host) for host in settings.allowed_target_hosts)

    def validate_url(self, value: str) -> str:
        _, host = parse_target_url(value)
        if self.allowed_hosts and host not in self.allowed_hosts:
            raise ValueError("Target hostname is not in ALLOWED_TARGET_HOSTS")
        if not self.allow_private:
            if host == "localhost" or host.endswith(".localhost"):
                raise ValueError("Local and private targets are disabled")
            try:
                is_ip = ipaddress.ip_address(host)
            except ValueError:
                is_ip = None
            if is_ip is not None and not is_public_address(host):
                raise ValueError("Local and private targets are disabled")
        return host
