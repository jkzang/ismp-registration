from rest_framework import serializers

from . import models

# Header names only; the phone and email columns are used for matching in the browser, never imported.
FIELD_KEYS = (
    'name', 'first_name', 'last_name', 'nickname', 'gender', 'level', 'status', 'timestamp',
    'attendance', 'phone', 'email',
)


class ChapterSerializer(serializers.ModelSerializer):
    class Meta:
        model = models.Chapter
        fields = ['id', 'name']

    def validate_name(self, value):
        value = ' '.join(value.split())
        if models.Chapter.objects.filter(name__iexact=value).exists():
            raise serializers.ValidationError('A chapter with that name already exists. Join it instead.')
        return value


class MentorSerializer(serializers.ModelSerializer):
    class Meta:
        model = models.Mentor
        fields = ['id', 'name', 'gender']

    def validate_name(self, value):
        return ' '.join(value.split())


class RowSerializer(serializers.Serializer):
    """One standardized sign-up row. Anything else in the sheet is dropped in the browser."""
    key = serializers.CharField(max_length=80)
    name = serializers.CharField(max_length=200)
    nickname = serializers.CharField(max_length=120, allow_blank=True, default='')
    gender = serializers.ChoiceField(choices=models.Gender.choices, allow_blank=True, default='')
    level = serializers.ChoiceField(choices=models.Level.choices, allow_blank=True, default='')
    status = serializers.ChoiceField(choices=models.ContactStatus.choices, default=models.ContactStatus.NOT_CONTACTED)


class RowsSerializer(serializers.Serializer):
    spreadsheet_title = serializers.CharField(max_length=200)
    tab_title = serializers.CharField(max_length=200)
    field_map = serializers.DictField(child=serializers.CharField(max_length=200, allow_blank=True))
    rows = RowSerializer(many=True, max_length=5000)
    warnings = serializers.ListField(child=serializers.CharField(max_length=500), max_length=20, required=False, default=list)

    def validate_field_map(self, value):
        unknown = set(value) - set(FIELD_KEYS)
        if unknown:
            raise serializers.ValidationError(f'Unknown fields: {", ".join(sorted(unknown))}.')
        return value

    def validate_rows(self, rows):
        keys = [r['key'] for r in rows]
        if len(keys) != len(set(keys)):
            raise serializers.ValidationError('Each row needs a unique key.')
        return rows


class SheetImportSerializer(RowsSerializer):
    spreadsheet_id = serializers.RegexField(r'^[A-Za-z0-9_-]{10,128}$')
    tab_id = serializers.IntegerField(min_value=0)
    # Asked for at import; both can be changed on the sheet afterwards.
    starts_at = serializers.DateTimeField()
    capacity = serializers.IntegerField(min_value=1, max_value=100000)
    # Mentors who won't be there; the first plan leaves them out. Changed on the Tables board afterwards.
    absent_mentor_ids = serializers.ListField(child=serializers.IntegerField(), default=list, max_length=500)


class SheetSerializer(serializers.ModelSerializer):
    imported_by = serializers.SerializerMethodField()
    signup_count = serializers.IntegerField(read_only=True)
    expires_at = serializers.DateTimeField(read_only=True)

    class Meta:
        model = models.SignupSheet
        fields = [
            'id', 'name', 'spreadsheet_id', 'spreadsheet_title', 'tab_id', 'tab_title', 'field_map', 'warnings',
            'capacity', 'starts_at', 'reserved_released_at', 'imported_at', 'synced_at', 'expires_at', 'imported_by',
            'signup_count',
        ]
        read_only_fields = [f for f in fields if f not in ('name', 'capacity', 'starts_at', 'reserved_released_at')]

    def validate_name(self, value):
        return value.strip()

    def get_imported_by(self, sheet):
        profile = getattr(sheet.imported_by, 'profile', None) if sheet.imported_by else None
        return profile.display_name if profile else None


class CheckInSerializer(serializers.Serializer):
    gender = serializers.ChoiceField(choices=models.Gender.choices, required=False)
    level = serializers.ChoiceField(choices=[models.UNDERGRAD, models.GRAD], required=False)


class SimulateSerializer(serializers.Serializer):
    attendance = serializers.IntegerField(min_value=0, max_value=100000, required=False, allow_null=True)


class TableMemberSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=['student', 'mentor'])
    id = serializers.IntegerField()
    locked = serializers.BooleanField(default=False)


class TableSerializer(serializers.Serializer):
    id = serializers.CharField(max_length=32)
    name = serializers.CharField(max_length=60)
    gender = serializers.ChoiceField(choices=[models.FEMALE, models.MALE, 'coed'], allow_blank=True, default='')
    level = serializers.ChoiceField(choices=[models.UNDERGRAD, models.GRAD], allow_blank=True, default='')
    members = TableMemberSerializer(many=True, max_length=200)

    def validate(self, data):
        if data['gender'] == 'coed' and not data['level']:
            raise serializers.ValidationError('A coed table needs a level: undergrad or grad.')
        return data


class PlanUpdateSerializer(serializers.Serializer):
    tables = TableSerializer(many=True, max_length=100)
    excluded_mentor_ids = serializers.ListField(child=serializers.IntegerField(), default=list, max_length=500)
    # When the board was loaded; seats handed out at check-in since then are kept.
    updated_at = serializers.DateTimeField(required=False)
