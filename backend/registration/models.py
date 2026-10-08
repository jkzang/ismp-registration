from datetime import timedelta

from django.conf import settings
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone

FEMALE, MALE = 'female', 'male'
UNDERGRAD, GRAD, OTHER = 'undergrad', 'grad', 'other'


class Gender(models.TextChoices):
    FEMALE = FEMALE, 'Female'
    MALE = MALE, 'Male'


class Level(models.TextChoices):
    UNDERGRAD = UNDERGRAD, 'Undergrad'
    GRAD = GRAD, 'Grad'
    # Enrollment "Other": not a student. Kept on the list but never planned for.
    OTHER = OTHER, 'Other'


class ContactStatus(models.TextChoices):
    NOT_CONTACTED = 'not_contacted', 'Not contacted'
    WAITING_TO_CONTACT = 'waiting_to_contact', 'Waiting to contact'
    AWAITING_RESPONSE = 'awaiting_response', 'Awaiting response'
    CONFIRMED = 'confirmed', 'Confirmed'
    NO_RESPONSE = 'no_response', 'No response'
    NOT_COMING = 'not_coming', 'Not coming'
    NO_ROOM = 'no_room', 'No room'
    # Listed by name only: left out of the turnout, the simulation and every count unless they check in.
    NO_SPACE = 'no_space', 'No space'
    NOT_INVITING = 'not_inviting', 'Not inviting'


class Chapter(models.Model):
    name = models.CharField(max_length=80)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(Lower('name'), name='unique_chapter_name_ci')]
        ordering = ['name']

    def __str__(self):
        return self.name


class Profile(models.Model):
    """A Google sign-in. Only the Google account id and display name are kept, not the email."""
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='profile')
    google_sub = models.CharField(max_length=64, unique=True)
    display_name = models.CharField(max_length=120, blank=True)
    chapter = models.ForeignKey(Chapter, on_delete=models.SET_NULL, null=True, blank=True, related_name='members')

    def __str__(self):
        return self.display_name or self.google_sub


class Mentor(models.Model):
    chapter = models.ForeignKey(Chapter, on_delete=models.CASCADE, related_name='mentors')
    name = models.CharField(max_length=120)
    gender = models.CharField(max_length=10, choices=Gender.choices)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


class SignupSheet(models.Model):
    """One import of one Google Sheets tab. Importing the same tab again makes another one."""
    chapter = models.ForeignKey(Chapter, on_delete=models.CASCADE, related_name='sheets')
    imported_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
    spreadsheet_id = models.CharField(max_length=128)
    spreadsheet_title = models.CharField(max_length=200)
    tab_id = models.BigIntegerField()
    tab_title = models.CharField(max_length=200)
    # What the organizers call it; blank shows the tab's title.
    name = models.CharField(max_length=200, blank=True)
    # Standard field -> the sheet's column header it came from, so a re-sync reads the same columns.
    field_map = models.JSONField(default=dict)
    # What the browser noticed about the tab's formatting at the last import or re-sync, in plain words.
    warnings = models.JSONField(default=list, blank=True)
    capacity = models.PositiveIntegerField(null=True, blank=True)
    # Confirmed people's spots are held until 20 minutes after this; see RESERVE_MINUTES in capacity.ts.
    starts_at = models.DateTimeField(null=True, blank=True)
    # Set when the door volunteer releases those spots early (or without a start time).
    reserved_released_at = models.DateTimeField(null=True, blank=True)
    # When the sheet was read for the rows last synced (a sync ticket's time), or when a status was last
    # set in the app. A re-sync from an older read is turned away, so it can't undo newer changes.
    rows_read_at = models.DateTimeField(null=True, blank=True)
    imported_at = models.DateTimeField(auto_now_add=True)
    synced_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['-imported_at']

    def __str__(self):
        return f'{self.spreadsheet_title} / {self.tab_title}'

    @property
    def expires_at(self):
        return self.synced_at + timedelta(days=settings.SIGNUP_RETENTION_DAYS)

    @classmethod
    def purge_expired(cls):
        cutoff = timezone.now() - timedelta(days=settings.SIGNUP_RETENTION_DAYS)
        return cls.objects.filter(synced_at__lt=cutoff).delete()[0]


class Signup(models.Model):
    """A standardized sign-up row. Contact details from the sheet are never sent here."""
    sheet = models.ForeignKey(SignupSheet, on_delete=models.CASCADE, related_name='signups')
    # Hash of the row's timestamp and name; matches rows across re-syncs.
    row_key = models.CharField(max_length=80)
    name = models.CharField(max_length=200)
    nickname = models.CharField(max_length=120, blank=True)
    gender = models.CharField(max_length=10, choices=Gender.choices, blank=True)
    level = models.CharField(max_length=10, choices=Level.choices, blank=True)
    status = models.CharField(max_length=20, choices=ContactStatus.choices, default=ContactStatus.NOT_CONTACTED)
    # Asked at the door when the sheet didn't say; the sheet's answer wins when it has one.
    door_gender = models.CharField(max_length=10, choices=Gender.choices, blank=True)
    door_level = models.CharField(max_length=10, choices=Level.choices, blank=True)
    checked_in_at = models.DateTimeField(null=True, blank=True)
    checked_in_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True)
    # Set when they're put on the door's waitlist; kept through check-in so undoing it puts them back in line.
    waitlisted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['sheet', 'row_key'], name='unique_row_per_sheet')]
        ordering = ['name']

    def __str__(self):
        return self.name

    @property
    def effective_gender(self):
        return self.gender or self.door_gender

    @property
    def effective_level(self):
        return self.level or self.door_level


class SeatingPlan(models.Model):
    """How a sheet's sign-ups and the chapter's mentors are split into tables. Edited as a whole board."""
    sheet = models.OneToOneField(SignupSheet, on_delete=models.CASCADE, related_name='plan')
    # [{id, name, gender, level, members: [{kind: 'student'|'mentor', id, locked}]}]; "student" ids are
    # Signup ids and "mentor" ids are Mentor ids. Validated in seating.py.
    tables = models.JSONField(default=list)
    excluded_mentors = models.ManyToManyField(Mentor, blank=True, related_name='+')
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'Tables for {self.sheet}'
