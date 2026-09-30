from django.conf import settings
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token


class NotAllowed(Exception):
    pass


def verify_credential(credential):
    """Verifies a Google Sign-In ID token and returns its claims, if it belongs to the allowed domain.

    Workspace accounts carry an `hd` claim; a Google account registered on an address at the domain
    doesn't, so a verified email at the domain is accepted too."""
    if not settings.GOOGLE_CLIENT_ID:
        raise NotAllowed('Google sign-in is not configured on the server.')
    try:
        claims = id_token.verify_oauth2_token(credential, google_requests.Request(), settings.GOOGLE_CLIENT_ID)
    except ValueError as err:
        raise NotAllowed('That Google sign-in could not be verified.') from err
    domain = settings.ALLOWED_GOOGLE_DOMAIN
    email = (claims.get('email') or '').lower()
    in_domain = (claims.get('hd') or '').lower() == domain or (
        claims.get('email_verified') and email.endswith('@' + domain)
    )
    if not in_domain:
        raise NotAllowed(f'Sign in with your @{domain} Google account.')
    return claims
