from django.conf import settings
from django.contrib.auth import get_user_model, login, logout
from django.db import transaction
from django.db.models import Count
from django.http import Http404, HttpResponse
from django.utils import timezone
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.http import require_safe
from rest_framework import mixins, serializers as drf_serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from . import models, seating, serializers
from .access import SignedIn, chapter_of
from .google_auth import NotAllowed, verify_credential


@require_safe
def frontend_index(request):
    """The built React app's index.html, for any page path; the app routes in the browser."""
    index = settings.FRONTEND_DIST / 'index.html'
    if not index.is_file():
        raise Http404('The frontend isn’t built. Run npm run build in frontend/, or use the Vite dev server.')
    response = HttpResponse(index.read_bytes(), content_type='text/html; charset=utf-8')
    # Always revalidate, so a deploy's new asset filenames are picked up right away.
    response['Cache-Control'] = 'no-cache'
    return response


def user_payload(user):
    if not user.is_authenticated or not hasattr(user, 'profile'):
        return None
    chapter = user.profile.chapter
    return {
        'display_name': user.profile.display_name,
        'chapter': {'id': chapter.id, 'name': chapter.name} if chapter else None,
    }


class ConfigView(APIView):
    """Public settings the browser needs to talk to Google."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        return Response({
            'google_client_id': settings.GOOGLE_CLIENT_ID,
            'google_api_key': settings.GOOGLE_API_KEY,
            'google_app_id': settings.GOOGLE_APP_ID,
            'allowed_domain': settings.ALLOWED_GOOGLE_DOMAIN,
            'retention_days': settings.SIGNUP_RETENTION_DAYS,
        })


@method_decorator(ensure_csrf_cookie, name='dispatch')
class MeView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({'user': user_payload(request.user)})


# DRF skips CSRF checks for anonymous requests, so sign-in opts back in to block login CSRF.
@method_decorator(csrf_protect, name='dispatch')
class GoogleLoginView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'

    def post(self, request):
        credential = request.data.get('credential')
        if not isinstance(credential, str) or not credential:
            return Response({'detail': 'Missing Google credential.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            claims = verify_credential(credential)
        except NotAllowed as err:
            return Response({'detail': str(err)}, status=status.HTTP_403_FORBIDDEN)
        profile = models.Profile.objects.filter(google_sub=claims['sub']).select_related('user').first()
        name = (claims.get('name') or '')[:120]
        if profile is None:
            user = get_user_model().objects.create_user(username=f'google-{claims["sub"]}')
            user.set_unusable_password()
            user.save()
            profile = models.Profile.objects.create(user=user, google_sub=claims['sub'], display_name=name)
        elif name and profile.display_name != name:
            profile.display_name = name
            profile.save(update_fields=['display_name'])
        if not profile.user.is_active:
            return Response({'detail': 'This account is disabled.'}, status=status.HTTP_403_FORBIDDEN)
        login(request, profile.user)
        return Response({'user': user_payload(profile.user)})


class LogoutView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChapterViewSet(mixins.ListModelMixin, mixins.CreateModelMixin, viewsets.GenericViewSet):
    """Anyone signed in may create a chapter or join any existing one."""
    permission_classes = [SignedIn]
    serializer_class = serializers.ChapterSerializer

    def get_queryset(self):
        qs = models.Chapter.objects.all()
        q = self.request.query_params.get('q', '').strip()
        return qs.filter(name__icontains=q) if q else qs

    def perform_create(self, serializer):
        chapter = serializer.save()
        self.request.user.profile.chapter = chapter
        self.request.user.profile.save(update_fields=['chapter'])

    def create(self, request, *args, **kwargs):
        super().create(request, *args, **kwargs)
        return Response({'user': user_payload(request.user)}, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'])
    def join(self, request, pk=None):
        profile = request.user.profile
        profile.chapter = self.get_object()
        profile.save(update_fields=['chapter'])
        return Response({'user': user_payload(request.user)})


class ChapterScoped:
    def chapter(self):
        return chapter_of(self.request.user)


class MentorViewSet(ChapterScoped, viewsets.ModelViewSet):
    serializer_class = serializers.MentorSerializer

    def get_queryset(self):
        return models.Mentor.objects.filter(chapter=self.chapter())

    def perform_create(self, serializer):
        serializer.save(chapter=self.chapter())


def replace_rows(sheet, rows):
    """Applies a (re-)import: matches rows by key, keeps check-ins and door answers, and drops rows
    no longer in the sheet unless that person already checked in."""
    existing = {s.row_key: s for s in sheet.signups.all()}
    incoming = {r['key'] for r in rows}
    fields = ['name', 'nickname', 'gender', 'level', 'status']
    to_update, to_create = [], []
    for row in rows:
        values = {f: row[f] for f in fields}
        signup = existing.get(row['key'])
        if signup is None:
            to_create.append(models.Signup(sheet=sheet, row_key=row['key'], **values))
        else:
            for f, v in values.items():
                setattr(signup, f, v)
            to_update.append(signup)
    models.Signup.objects.bulk_create(to_create)
    models.Signup.objects.bulk_update(to_update, fields)
    gone = [s.id for key, s in existing.items() if key not in incoming and s.checked_in_at is None]
    models.Signup.objects.filter(id__in=gone).delete()
    return {'added': len(to_create), 'updated': len(to_update), 'removed': len(gone)}


class SheetViewSet(ChapterScoped, mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.UpdateModelMixin,
                   mixins.DestroyModelMixin, viewsets.GenericViewSet):
    serializer_class = serializers.SheetSerializer
    http_method_names = ['get', 'post', 'put', 'patch', 'delete']

    def get_queryset(self):
        return models.SignupSheet.objects.filter(chapter=self.chapter()).annotate(
            signup_count=Count('signups'),
        ).select_related('imported_by__profile')

    def list(self, request, *args, **kwargs):
        # No background worker on a free host, so retention is enforced whenever the list is read.
        models.SignupSheet.purge_expired()
        return super().list(request, *args, **kwargs)

    def update(self, request, *args, **kwargs):
        if not kwargs.get('partial'):
            raise drf_serializers.ValidationError('Use PATCH to change the name, capacity, or start time.')
        return super().update(request, *args, **kwargs)

    def create(self, request):
        payload = serializers.SheetImportSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        with transaction.atomic():
            sheet = models.SignupSheet.objects.create(
                chapter=self.chapter(), imported_by=request.user,
                **{k: data[k] for k in (
                    'spreadsheet_id', 'spreadsheet_title', 'tab_id', 'tab_title', 'field_map', 'warnings',
                    'starts_at', 'capacity',
                )},
            )
            replace_rows(sheet, data['rows'])
            # A first plan right away, so the organizer lands on tables rather than an empty board.
            students, mentors = seating.attendees(sheet)
            absent = set(data['absent_mentor_ids'])
            if not absent <= {m['id'] for m in mentors}:
                raise drf_serializers.ValidationError('Only mentors in this chapter can be marked as absent.')
            plan = models.SeatingPlan.objects.create(
                sheet=sheet, tables=seating.generate(students, [m for m in mentors if m['id'] not in absent], []),
            )
            plan.excluded_mentors.set(absent)
        return Response(self.get_serializer(self.get_queryset().get(pk=sheet.pk)).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['put'])
    def rows(self, request, pk=None):
        """Re-sync from the Google Sheet."""
        sheet = self.get_object()
        payload = serializers.RowsSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = payload.validated_data
        with transaction.atomic():
            self._locked_plan(sheet)
            counts = replace_rows(sheet, data['rows'])
            sheet.spreadsheet_title, sheet.tab_title = data['spreadsheet_title'], data['tab_title']
            sheet.field_map, sheet.warnings = data['field_map'], data['warnings']
            sheet.synced_at = timezone.now()
            sheet.save()
        return Response({'sheet': self.get_serializer(self.get_queryset().get(pk=sheet.pk)).data, **counts})

    def _locked_plan(self, sheet):
        # Locked so a board save, re-plan or re-sync can't overwrite a seat handed out at check-in.
        models.SeatingPlan.objects.get_or_create(sheet=sheet)
        return models.SeatingPlan.objects.select_for_update().get(sheet=sheet)

    @action(detail=True, methods=['get', 'put'])
    def plan(self, request, pk=None):
        sheet = self.get_object()
        if request.method == 'GET':
            plan, _ = models.SeatingPlan.objects.get_or_create(sheet=sheet)
            return Response(seating.plan_payload(plan))
        payload = serializers.PlanUpdateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        with transaction.atomic():
            plan = self._locked_plan(sheet)
            students, mentors = seating.attendees(sheet)
            excluded = payload.validated_data['excluded_mentor_ids']
            # Checked before check-in seats are put back, so a check-in the organizer never saw can't fail the save.
            tables = seating.clean_tables(
                [dict(t, members=[dict(m) for m in t['members']]) for t in payload.validated_data['tables']],
                students, mentors, excluded, plan.tables,
            )
            plan.tables = seating.keep_new_check_ins(
                tables, plan.tables, sheet.signups.all(), payload.validated_data.get('updated_at'),
            )
            plan.save()
            plan.excluded_mentors.set(excluded)
        return Response(seating.plan_payload(plan))

    @action(detail=True, methods=['post'], url_path='plan/generate')
    def generate_plan(self, request, pk=None):
        sheet = self.get_object()
        with transaction.atomic():
            plan = self._locked_plan(sheet)
            # Once people are arriving, re-planning would move mentors away from students already told their table.
            if plan.tables and sheet.signups.filter(checked_in_at__isnull=False).exists():
                raise drf_serializers.ValidationError('Check-in has started, so the tables can’t be re-planned.')
            students, mentors = seating.attendees(sheet)
            excluded = set(plan.excluded_mentors.values_list('id', flat=True))
            plan.tables = seating.generate(students, [m for m in mentors if m['id'] not in excluded], plan.tables)
            plan.save()
        return Response(seating.plan_payload(plan))


class SignupViewSet(ChapterScoped, viewsets.GenericViewSet):
    def get_queryset(self):
        return models.Signup.objects.filter(sheet__chapter=self.chapter())

    # Check-in is allowed past capacity on purpose: the door volunteer decides; the UI warns.
    @action(detail=True, methods=['post'], url_path='check-in')
    def check_in(self, request, pk=None):
        details = serializers.CheckInSerializer(data=request.data)
        details.is_valid(raise_exception=True)
        with transaction.atomic():
            signup = self.get_queryset().select_for_update(of=('self',)).get(pk=self.get_object().pk)
            if 'gender' in details.validated_data:
                signup.door_gender = details.validated_data['gender']
            if 'level' in details.validated_data:
                signup.door_level = details.validated_data['level']
            if signup.checked_in_at is None:
                signup.checked_in_at = timezone.now()
                signup.checked_in_by = request.user
            signup.save()
            table = seating.seat_at_check_in(signup)
        return Response({'student': seating.student_of(signup), 'table': table})

    # Who gets waitlisted is up to the door volunteer; the UI works it out from capacity and confirmations.
    # It never touches the Google Sheet.
    @action(detail=True, methods=['post'])
    def waitlist(self, request, pk=None):
        signup = self.get_object()
        if signup.checked_in_at is not None:
            raise drf_serializers.ValidationError('They’re already checked in.')
        if signup.waitlisted_at is None:
            signup.waitlisted_at = timezone.now()
            signup.save(update_fields=['waitlisted_at'])
        return Response({'student': seating.student_of(signup)})

    @action(detail=True, methods=['post'], url_path='undo-waitlist')
    def undo_waitlist(self, request, pk=None):
        signup = self.get_object()
        signup.waitlisted_at = None
        signup.save(update_fields=['waitlisted_at'])
        return Response({'student': seating.student_of(signup)})

    @action(detail=True, methods=['post'], url_path='undo-check-in')
    def undo_check_in(self, request, pk=None):
        signup = self.get_object()
        with transaction.atomic():
            signup.checked_in_at = None
            signup.checked_in_by = None
            signup.save(update_fields=['checked_in_at', 'checked_in_by'])
            seating.unseat_after_undo(signup)
        return Response({'student': seating.student_of(signup)})
