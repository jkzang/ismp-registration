from django.conf import settings

# Only what the frontend loads: Google sign-in, the Drive Picker, the Sheets API, and Google Fonts.
# Inline styles are allowed because Google's sign-in button and Picker add their own.
POLICY = '; '.join([
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client https://apis.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com",
    "connect-src 'self' https://accounts.google.com/gsi/ https://sheets.googleapis.com"
    " https://www.googleapis.com https://content.googleapis.com",
    "frame-src https://accounts.google.com https://docs.google.com https://drive.google.com"
    " https://content.googleapis.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


class ContentSecurityPolicyMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        header = 'Content-Security-Policy-Report-Only' if settings.CSP_REPORT_ONLY else 'Content-Security-Policy'
        response.headers.setdefault(header, POLICY)
        return response
