import os
import re
from pathlib import Path

import dj_database_url
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent


def load_env_file(path):
    """Minimal .env reader so local dev needs no extra package; real env vars win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(BASE_DIR / '.env')

DEBUG = os.environ.get('DJANGO_DEBUG', '') == '1'

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', '')
if not SECRET_KEY:
    if not DEBUG:
        raise ImproperlyConfigured('Set DJANGO_SECRET_KEY (or DJANGO_DEBUG=1 for local development).')
    SECRET_KEY = 'dev-only-insecure-key'

ALLOWED_HOSTS = [h for h in os.environ.get('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1').split(',') if h]
CSRF_TRUSTED_ORIGINS = [o for o in os.environ.get('DJANGO_CSRF_TRUSTED_ORIGINS', '').split(',') if o]
# Render sets this to the service's onrender.com hostname.
if os.environ.get('RENDER_EXTERNAL_HOSTNAME'):
    ALLOWED_HOSTS.append(os.environ['RENDER_EXTERNAL_HOSTNAME'])

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')
# Browser key for the Google Picker; public by design, restrict it by HTTP referrer in Google Cloud.
GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY', '')
# The Google Cloud project number; the Picker needs it so picked files are shared with this app.
GOOGLE_APP_ID = os.environ.get('GOOGLE_APP_ID', '')
ALLOWED_GOOGLE_DOMAIN = os.environ.get('ALLOWED_GOOGLE_DOMAIN', 'acts2.network').lower()

# Imported sign-ups are deleted this many days after their last import or re-sync.
SIGNUP_RETENTION_DAYS = int(os.environ.get('SIGNUP_RETENTION_DAYS', '30'))

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'registration',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'config.csp.ContentSecurityPolicyMiddleware',
    # Serves the built frontend (FRONTEND_DIST) in production; the SPA fallback is in urls.py.
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.SessionAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'registration.access.InChapter',
    ],
    'DEFAULT_THROTTLE_RATES': {
        'login': '20/min',
    },
    # How many proxies sit in front of the app, so throttling uses the client's IP from X-Forwarded-For
    # instead of a value the client could make up. Unset means the whole header is used.
    'NUM_PROXIES': int(os.environ['TRUSTED_PROXY_COUNT']) if os.environ.get('TRUSTED_PROXY_COUNT') else None,
}
if not DEBUG:
    # The browsable API needs static files and isn't useful to anyone in production.
    REST_FRAMEWORK['DEFAULT_RENDERER_CLASSES'] = ['rest_framework.renderers.JSONRenderer']

if os.environ.get('DATABASE_URL'):
    # Production (Neon). Use Neon's direct connection string, not the pooled one.
    DATABASES = {
        'default': dj_database_url.parse(
            os.environ['DATABASE_URL'], conn_max_age=60, conn_health_checks=True, ssl_require=not DEBUG,
        ),
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': os.environ.get('DB_NAME', 'ismp-registration'),
            'USER': os.environ.get('DB_USER', os.environ.get('USER', '')),
            'PASSWORD': os.environ.get('DB_PASSWORD', ''),
            'HOST': os.environ.get('DB_HOST', 'localhost'),
            'PORT': os.environ.get('DB_PORT', '5432'),
        }
    }

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'

# The Vite build. WhiteNoise serves its files at the site root, and every other non-API path gets
# its index.html. In development Vite serves the frontend instead.
FRONTEND_DIST = BASE_DIR.parent / 'frontend' / 'dist'
if FRONTEND_DIST.is_dir():
    WHITENOISE_ROOT = FRONTEND_DIST


def is_hashed_asset(path, url):
    # Vite puts a content hash in every filename under /assets/, so those can be cached forever.
    return bool(re.match(r'^/assets/.+-[A-Za-z0-9_-]{8}\.\w+$', url))


WHITENOISE_IMMUTABLE_FILE_TEST = is_hashed_asset

# Google's sign-in and token popups need to talk back to this page.
SECURE_CROSS_ORIGIN_OPENER_POLICY = 'same-origin-allow-popups'
# Sends the origin to Google, so an API key restricted by HTTP referrer still works for the Picker.
SECURE_REFERRER_POLICY = 'strict-origin-when-cross-origin'
X_FRAME_OPTIONS = 'DENY'
# While on, the CSP is only reported in the browser console, so a wrong rule can't break sign-in.
CSP_REPORT_ONLY = os.environ.get('DJANGO_CSP_REPORT_ONLY', '') == '1'

if not DEBUG:
    # Render terminates HTTPS and sets X-Forwarded-Proto.
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    # Raise once the site has run fine over HTTPS for a while, e.g. to 31536000 (a year).
    SECURE_HSTS_SECONDS = int(os.environ.get('DJANGO_HSTS_SECONDS', '3600'))
    # Subdomains and preload are for a domain you own; onrender.com's other subdomains aren't ours.
    SILENCED_SYSTEM_CHECKS = ['security.W005', 'security.W021']
    # A volunteer stays signed in for a week of events, not Django's default two weeks.
    SESSION_COOKIE_AGE = 60 * 60 * 24 * 7

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    # Render keeps whatever goes to stdout/stderr; this makes sure server errors land there.
    # DJANGO_LOG_LEVEL=WARNING adds 4xx responses.
    'loggers': {'django': {'handlers': ['console'], 'level': os.environ.get('DJANGO_LOG_LEVEL', 'ERROR')}},
}

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
