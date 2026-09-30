from django.core.management.base import BaseCommand

from registration.models import SignupSheet


class Command(BaseCommand):
    help = 'Deletes imported sign-up sheets past the retention period (SIGNUP_RETENTION_DAYS).'

    def handle(self, *args, **options):
        deleted = SignupSheet.purge_expired()
        self.stdout.write(f'Deleted {deleted} rows from expired sheets.')
