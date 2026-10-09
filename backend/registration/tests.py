import random
import shutil
import tempfile
from collections import Counter
from datetime import timedelta
from pathlib import Path
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from . import models, seating
from .google_auth import NotAllowed, verify_credential


def make_member(sub, chapter, name='Volunteer'):
    user = get_user_model().objects.create_user(username=f'google-{sub}')
    models.Profile.objects.create(user=user, google_sub=sub, display_name=name, chapter=chapter)
    return user


def row(key, name, gender='', level='', status='confirmed', nickname=''):
    return {'key': key, 'name': name, 'nickname': nickname, 'gender': gender, 'level': level, 'status': status}


def import_body(rows, **extra):
    return {
        'spreadsheet_id': 'abcdefghij1234567890', 'spreadsheet_title': 'Fall Kickoff', 'tab_id': 0,
        'tab_title': 'Form Responses 1', 'field_map': {'name': 'First & Last Name'}, 'rows': rows,
        'event_name': 'Fall Kickoff', 'starts_at': '2026-10-01T19:00:00Z', 'capacity': 60, **extra,
    }


class ApiTestBase(APITestCase):
    def setUp(self):
        self.chapter = models.Chapter.objects.create(name='San Diego')
        self.other_chapter = models.Chapter.objects.create(name='Irvine')
        self.user = make_member('111', self.chapter, 'Jack')
        self.client.force_authenticate(self.user)

    def import_sheet(self, rows):
        response = self.client.post('/api/sheets/', import_body(rows), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        return models.SignupSheet.objects.get(pk=response.data['id'])


@override_settings(GOOGLE_CLIENT_ID='client-123', ALLOWED_GOOGLE_DOMAIN='acts2.network')
class GoogleSignInTests(APITestCase):
    def setUp(self):
        cache.clear()  # the sign-in throttle counts in the cache

    def claims(self, **overrides):
        return {'sub': '999', 'name': 'New Person', 'email': 'new@acts2.network', 'email_verified': True,
                'hd': 'acts2.network', **overrides}

    def test_verify_accepts_workspace_and_verified_domain_email(self):
        for claims in (self.claims(), self.claims(hd=None)):
            with mock.patch('registration.google_auth.id_token.verify_oauth2_token', return_value=claims):
                self.assertEqual(verify_credential('token')['sub'], '999')

    def test_verify_rejects_other_domains_and_unverified_email(self):
        for claims in (
            self.claims(hd='gmail.com', email='x@gmail.com'),
            self.claims(hd=None, email='x@gmail.com'),
            self.claims(hd=None, email_verified=False),
            self.claims(hd=None, email='x@evil-acts2.network'),
        ):
            with mock.patch('registration.google_auth.id_token.verify_oauth2_token', return_value=claims):
                with self.assertRaises(NotAllowed):
                    verify_credential('token')

    def test_verify_accepts_tokens_from_the_desktop_client(self):
        with mock.patch('registration.google_auth.id_token.verify_oauth2_token', return_value=self.claims()) as verify:
            with override_settings(GOOGLE_DESKTOP_CLIENT_ID=''):
                verify_credential('token')
            self.assertEqual(verify.call_args.args[2], ['client-123'])
            with override_settings(GOOGLE_DESKTOP_CLIENT_ID='desktop-456'):
                verify_credential('token')
            self.assertEqual(verify.call_args.args[2], ['client-123', 'desktop-456'])

    def test_verify_rejects_bad_tokens(self):
        with mock.patch('registration.google_auth.id_token.verify_oauth2_token', side_effect=ValueError('bad')):
            with self.assertRaises(NotAllowed):
                verify_credential('token')

    def test_sign_in_creates_account_without_storing_email(self):
        with mock.patch('registration.views.verify_credential', return_value=self.claims()):
            response = self.client.post('/api/auth/google/', {'credential': 'token'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['user'], {'display_name': 'New Person', 'chapter': None})
        user = get_user_model().objects.get(profile__google_sub='999')
        self.assertEqual(user.email, '')
        self.assertFalse(user.has_usable_password())
        self.assertEqual(self.client.get('/api/auth/me/').data['user']['display_name'], 'New Person')

    def test_sign_in_outside_domain_is_refused(self):
        with mock.patch('registration.views.verify_credential', side_effect=NotAllowed('Nope')):
            response = self.client.post('/api/auth/google/', {'credential': 'token'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(models.Profile.objects.exists())

    def test_sign_in_requires_csrf_token(self):
        client = APIClient(enforce_csrf_checks=True)
        with mock.patch('registration.views.verify_credential', return_value=self.claims()):
            response = client.post('/api/auth/google/', {'credential': 'token'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_sign_in_is_throttled(self):
        with mock.patch('registration.views.verify_credential', side_effect=NotAllowed('Nope')):
            codes = [self.client.post('/api/auth/google/', {'credential': 'token'}, format='json').status_code
                     for _ in range(21)]
        self.assertEqual(codes[:20], [status.HTTP_403_FORBIDDEN] * 20)
        self.assertEqual(codes[20], status.HTTP_429_TOO_MANY_REQUESTS)


class ChapterTests(APITestCase):
    def setUp(self):
        self.user = make_member('222', None)
        self.client.force_authenticate(self.user)

    def test_without_a_chapter_nothing_else_is_reachable(self):
        for url in ('/api/sheets/', '/api/mentors/'):
            self.assertEqual(self.client.get(url).status_code, status.HTTP_403_FORBIDDEN)

    def test_create_chapter_joins_it(self):
        response = self.client.post('/api/chapters/', {'name': '  San   Diego '}, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['user']['chapter']['name'], 'San Diego')
        self.assertEqual(self.client.get('/api/sheets/').status_code, status.HTTP_200_OK)

    def test_chapter_names_are_unique_ignoring_case(self):
        models.Chapter.objects.create(name='San Diego')
        response = self.client.post('/api/chapters/', {'name': 'san diego'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_search_and_join_any_chapter(self):
        chapter = models.Chapter.objects.create(name='San Diego')
        models.Chapter.objects.create(name='Irvine')
        found = self.client.get('/api/chapters/?q=diego').data
        self.assertEqual([c['name'] for c in found], ['San Diego'])
        response = self.client.post(f'/api/chapters/{chapter.id}/join/')
        self.assertEqual(response.data['user']['chapter']['id'], chapter.id)

    def test_anonymous_users_cannot_list_chapters(self):
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get('/api/chapters/').status_code, status.HTTP_403_FORBIDDEN)


class MentorTests(ApiTestBase):
    def test_roster_is_per_chapter(self):
        self.client.post('/api/mentors/', {'name': 'Mia Chen', 'gender': 'female'}, format='json')
        models.Mentor.objects.create(chapter=self.other_chapter, name='Elsewhere', gender='male')
        self.assertEqual([m['name'] for m in self.client.get('/api/mentors/').data], ['Mia Chen'])

    def test_gender_is_required(self):
        response = self.client.post('/api/mentors/', {'name': 'Mia'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_other_chapters_mentors_cannot_be_edited(self):
        other = models.Mentor.objects.create(chapter=self.other_chapter, name='Elsewhere', gender='male')
        self.assertEqual(self.client.delete(f'/api/mentors/{other.id}/').status_code, status.HTTP_404_NOT_FOUND)


class ImportTests(ApiTestBase):
    def test_import_stores_only_standard_fields(self):
        body = import_body([{**row('k1', 'Amy Lin', 'female', 'grad'), 'email': 'amy@ucsd.edu', 'phone': '555'}])
        response = self.client.post('/api/sheets/', body, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        signup = models.Signup.objects.get()
        self.assertEqual((signup.name, signup.gender, signup.level, signup.status), ('Amy Lin', 'female', 'grad', 'confirmed'))
        self.assertFalse(hasattr(signup, 'email'))
        self.assertEqual(response.data['signup_count'], 1)
        self.assertEqual(response.data['imported_by'], 'Jack')

    def test_same_tab_can_be_imported_twice(self):
        self.import_sheet([row('k1', 'Amy')])
        self.import_sheet([row('k1', 'Amy')])
        self.assertEqual(len(self.client.get('/api/sheets/').data), 2)

    def test_bad_rows_are_rejected(self):
        for rows in ([row('k1', 'A', gender='other')], [row('k1', 'A', status='maybe')], [row('k', 'A'), row('k', 'B')]):
            response = self.client.post('/api/sheets/', import_body(rows), format='json')
            self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST, rows)
        response = self.client.post('/api/sheets/', import_body([], field_map={'wechat': 'WeChat ID'}), format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_resync_keeps_check_ins_and_door_answers(self):
        sheet = self.import_sheet([row('k1', 'Amy'), row('k2', 'Ben', 'male'), row('k3', 'Cat', 'female')])
        amy = sheet.signups.get(row_key='k1')
        cat = sheet.signups.get(row_key='k3')
        self.client.post(f'/api/signups/{amy.id}/check-in/', {'gender': 'female', 'level': 'grad'}, format='json')
        self.client.post(f'/api/signups/{cat.id}/check-in/')
        response = self.client.put(f'/api/sheets/{sheet.id}/rows/', {
            'spreadsheet_title': 'Fall Kickoff', 'tab_title': 'Renamed', 'field_map': {'name': 'Name'},
            'rows': [row('k1', 'Amy Lin', status='awaiting_response'), row('k4', 'Dan', 'male')],
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        self.assertEqual((response.data['added'], response.data['updated'], response.data['removed']), (1, 1, 1))
        amy.refresh_from_db()
        self.assertEqual((amy.name, amy.status, amy.effective_gender, amy.effective_level), ('Amy Lin', 'awaiting_response', 'female', 'grad'))
        self.assertIsNotNone(amy.checked_in_at)
        # Ben left the sheet and never came; Cat left it but already checked in, so she stays.
        self.assertEqual(sorted(sheet.signups.values_list('name', flat=True)), ['Amy Lin', 'Cat', 'Dan'])
        self.assertEqual(response.data['sheet']['tab_title'], 'Renamed')

    def test_import_needs_the_event_name_start_and_capacity(self):
        for missing in ('event_name', 'starts_at', 'capacity'):
            body = import_body([row('k1', 'Amy')])
            del body[missing]
            response = self.client.post('/api/sheets/', body, format='json')
            self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST, missing)
            self.assertIn(missing, response.data)
        response = self.client.post('/api/sheets/', import_body([row('k1', 'Amy')], capacity=0), format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        response = self.client.post('/api/sheets/', import_body([row('k1', 'Amy')], capacity=45), format='json')
        self.assertEqual((response.data['capacity'], response.data['starts_at']), (45, '2026-10-01T19:00:00Z'))
        response = self.client.post('/api/sheets/', import_body([row('k1', 'Amy')], event_name='  ISMP Game Night '), format='json')
        self.assertEqual(response.data['event_name'], 'ISMP Game Night')
        response = self.client.patch(f'/api/sheets/{response.data["id"]}/', {'event_name': 'Game Night'}, format='json')
        self.assertEqual(response.data['event_name'], 'Game Night')

    def test_import_leaves_absent_mentors_out_of_the_first_plan(self):
        here = models.Mentor.objects.create(chapter=self.chapter, name='Mia', gender='female')
        away = models.Mentor.objects.create(chapter=self.chapter, name='Ivy', gender='female')
        rows = [row(f'k{i}', f'Student {i}', 'female', 'grad') for i in range(4)]
        response = self.client.post('/api/sheets/', import_body(rows, absent_mentor_ids=[away.pk]), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        plan = self.client.get(f'/api/sheets/{response.data["id"]}/plan/').data
        seated = {m['id'] for t in plan['tables'] for m in t['members'] if m['kind'] == 'mentor'}
        self.assertEqual((seated, plan['excluded_mentor_ids']), ({here.pk}, [away.pk]))

    def test_import_rejects_absent_mentors_from_another_chapter(self):
        outsider = models.Mentor.objects.create(chapter=self.other_chapter, name='Zed', gender='male')
        body = import_body([row('k1', 'Amy')], absent_mentor_ids=[outsider.pk])
        response = self.client.post('/api/sheets/', body, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(models.SignupSheet.objects.exists())

    def test_import_plans_the_tables_right_away(self):
        mentor = models.Mentor.objects.create(chapter=self.chapter, name='Mia', gender='female')
        rows = [row(f'k{i}', f'Student {i}', 'female', 'grad') for i in range(12)]  # 10.2 expected
        sheet = self.import_sheet(rows)
        data = self.client.get(f'/api/sheets/{sheet.id}/plan/').data
        # Two tables wanted, but one mentor means one table.
        self.assertEqual([(t['gender'], t['level']) for t in data['tables']], [('female', 'grad')])
        self.assertEqual(data['tables'][0]['members'], [{'kind': 'mentor', 'id': mentor.id, 'locked': False}])
        wanted = {(e['gender'], e['level']): e['tables_wanted'] for e in data['expected']}
        self.assertEqual(wanted[('female', 'grad')], 2)
        self.assertEqual(wanted[('male', 'grad')], 0)

    def test_warnings_are_kept_until_the_next_sync(self):
        response = self.client.post('/api/sheets/', import_body([row('k1', 'Amy')], warnings=['No Gender column found.']), format='json')
        self.assertEqual(response.data['warnings'], ['No Gender column found.'])
        response = self.client.put(f"/api/sheets/{response.data['id']}/rows/", {
            'spreadsheet_title': 'Fall Kickoff', 'tab_title': 'Form Responses 1', 'field_map': {'name': 'Name'},
            'rows': [row('k1', 'Amy')],
        }, format='json')
        self.assertEqual(response.data['sheet']['warnings'], [])

    def test_start_time_and_early_release_are_editable(self):
        sheet = self.import_sheet([])
        response = self.client.patch(f'/api/sheets/{sheet.id}/', {'starts_at': '2026-10-01T19:00:00Z'}, format='json')
        self.assertEqual((response.data['starts_at'], response.data['reserved_released_at']), ('2026-10-01T19:00:00Z', None))
        response = self.client.patch(f'/api/sheets/{sheet.id}/', {'reserved_released_at': '2026-10-01T19:10:00Z'}, format='json')
        self.assertEqual(response.data['reserved_released_at'], '2026-10-01T19:10:00Z')
        response = self.client.patch(f'/api/sheets/{sheet.id}/', {'starts_at': None, 'reserved_released_at': None}, format='json')
        self.assertEqual((response.data['starts_at'], response.data['reserved_released_at']), (None, None))

    def test_import_details_are_read_only(self):
        sheet = self.import_sheet([])
        response = self.client.patch(f'/api/sheets/{sheet.id}/', {'capacity': 40, 'tab_title': 'x'}, format='json')
        self.assertEqual((response.data['capacity'], response.data['tab_title']), (40, 'Form Responses 1'))
        response = self.client.patch(f'/api/sheets/{sheet.id}/', {'capacity': None}, format='json')
        self.assertIsNone(response.data['capacity'])
        response = self.client.patch(f'/api/sheets/{sheet.id}/', {'name': '  Fall kickoff  '}, format='json')
        self.assertEqual((response.data['name'], response.data['tab_title']), ('Fall kickoff', 'Form Responses 1'))

    def test_other_chapters_sheets_are_off_limits(self):
        other_user = make_member('333', self.other_chapter)
        self.client.force_authenticate(other_user)
        sheet = self.import_sheet([row('k1', 'Amy')])
        signup = sheet.signups.get()
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get('/api/sheets/').data, [])
        for method, url in (
            ('get', f'/api/sheets/{sheet.id}/'), ('get', f'/api/sheets/{sheet.id}/plan/'),
            ('delete', f'/api/sheets/{sheet.id}/'), ('post', f'/api/signups/{signup.id}/check-in/'),
            ('post', f'/api/signups/{signup.id}/waitlist/'), ('put', f'/api/sheets/{sheet.id}/rows/'),
        ):
            self.assertEqual(getattr(self.client, method)(url, {}, format='json').status_code, status.HTTP_404_NOT_FOUND, url)

    def test_waitlist_survives_check_in_and_its_undo(self):
        sheet = self.import_sheet([row('k1', 'Amy', status='awaiting_response')])
        amy = sheet.signups.get()
        response = self.client.post(f'/api/signups/{amy.id}/waitlist/')
        self.assertIsNotNone(response.data['student']['waitlisted_at'])
        self.client.post(f'/api/signups/{amy.id}/check-in/')
        # Already in, so there's nothing to wait for.
        self.assertEqual(self.client.post(f'/api/signups/{amy.id}/waitlist/').status_code, status.HTTP_400_BAD_REQUEST)
        response = self.client.post(f'/api/signups/{amy.id}/undo-check-in/')
        self.assertFalse(response.data['student']['checked_in'])
        self.assertIsNotNone(response.data['student']['waitlisted_at'])
        response = self.client.post(f'/api/signups/{amy.id}/undo-waitlist/')
        self.assertIsNone(response.data['student']['waitlisted_at'])

    def test_status_can_be_set_from_the_app(self):
        sheet = self.import_sheet([row('k1', 'Amy', status='not_contacted')])
        amy = sheet.signups.get()
        response = self.client.post(f'/api/signups/{amy.id}/status/', {'status': 'confirmed'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        self.assertEqual(response.data['student']['status'], 'confirmed')
        amy.refresh_from_db()
        self.assertEqual(amy.status, 'confirmed')
        response = self.client.post(f'/api/signups/{amy.id}/status/', {'status': 'maybe'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.client.force_authenticate(make_member('555', self.other_chapter))
        response = self.client.post(f'/api/signups/{amy.id}/status/', {'status': 'not_coming'}, format='json')
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_resync_from_an_older_read_is_turned_away(self):
        sheet = self.import_sheet([row('k1', 'Amy', status='not_contacted')])
        body = lambda status_, ticket: {
            'spreadsheet_title': 'Fall Kickoff', 'tab_title': 'Form', 'field_map': {'name': 'Name'},
            'rows': [row('k1', 'Amy', status=status_)], 'read_at': ticket,
        }
        older = self.client.get(f'/api/sheets/{sheet.id}/sync-ticket/').data['ticket']
        newer = self.client.get(f'/api/sheets/{sheet.id}/sync-ticket/').data['ticket']
        response = self.client.put(f'/api/sheets/{sheet.id}/rows/', body('confirmed', newer), format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        # A device that read the sheet first, but sent later.
        response = self.client.put(f'/api/sheets/{sheet.id}/rows/', body('not_contacted', older), format='json')
        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(sheet.signups.get().status, 'confirmed')

        # A status set in the app turns away reads from before it, too.
        amy = sheet.signups.get()
        before_status = self.client.get(f'/api/sheets/{sheet.id}/sync-ticket/').data['ticket']
        self.client.post(f'/api/signups/{amy.id}/status/', {'status': 'not_coming'}, format='json')
        response = self.client.put(f'/api/sheets/{sheet.id}/rows/', body('confirmed', before_status), format='json')
        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        after = self.client.get(f'/api/sheets/{sheet.id}/sync-ticket/').data['ticket']
        response = self.client.put(f'/api/sheets/{sheet.id}/rows/', body('not_coming', after), format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_chapter_members_share_sheets(self):
        sheet = self.import_sheet([row('k1', 'Amy')])
        self.client.force_authenticate(make_member('444', self.chapter))
        self.assertEqual([s['id'] for s in self.client.get('/api/sheets/').data], [sheet.id])

    @override_settings(SIGNUP_RETENTION_DAYS=30)
    def test_expired_sheets_are_deleted_when_listed(self):
        old = self.import_sheet([row('k1', 'Amy')])
        fresh = self.import_sheet([row('k1', 'Ben')])
        models.SignupSheet.objects.filter(pk=old.pk).update(synced_at=timezone.now() - timedelta(days=31))
        self.assertEqual([s['id'] for s in self.client.get('/api/sheets/').data], [fresh.id])
        self.assertEqual(list(models.Signup.objects.values_list('name', flat=True)), ['Ben'])


class SeatingBase(ApiTestBase):
    def setUp(self):
        super().setUp()
        self.sheet = self.import_sheet([])
        self.counter = 0

    def add_students(self, count, gender, level, status='confirmed'):
        created = []
        for i in range(count):
            self.counter += 1
            created.append(models.Signup.objects.create(
                sheet=self.sheet, row_key=f'r{self.counter}', name=f'{gender}{level}{i}',
                gender=gender, level=level, status=status,
            ))
        return created

    def add_mentor(self, name, gender):
        return models.Mentor.objects.create(chapter=self.chapter, name=name, gender=gender)

    def generate(self):
        return self.client.post(f'/api/sheets/{self.sheet.id}/plan/generate/').data

    def plan(self):
        return self.client.get(f'/api/sheets/{self.sheet.id}/plan/').data

    def save_plan(self, body):
        return self.client.put(f'/api/sheets/{self.sheet.id}/plan/', body, format='json')

    def check_in(self, student, **door_answers):
        return self.client.post(f'/api/signups/{student.id}/check-in/', door_answers, format='json').data

    def groups(self, data):
        return [(t['gender'], t['level']) for t in data['tables']]

    def seated_students(self, data):
        return [[m['id'] for m in t['members'] if m['kind'] == 'student'] for t in data['tables']]


class TablePlanningTests(SeatingBase):
    def test_tables_come_from_expected_turnout_and_seat_no_students_yet(self):
        self.add_students(12, 'female', 'undergrad')  # 12 x 0.85 = 10.2 expected, 6 a table at most
        for name in ('Mia', 'Ava', 'Zoe', 'Ivy'):
            self.add_mentor(name, 'female')
        data = self.generate()
        self.assertEqual(self.groups(data), [('female', 'undergrad')] * 2)
        self.assertEqual(self.seated_students(data), [[], []])
        self.assertTrue(all(sum(m['kind'] == 'mentor' for m in t['members']) == 2 for t in data['tables']))

    def test_tables_leave_room_for_walk_ins(self):
        self.add_students(14, 'female', 'undergrad')  # 11.9 expected: two tables, but 13.7 with walk-ins
        for name in ('Mia', 'Ava', 'Zoe'):
            self.add_mentor(name, 'female')
        students, mentors = seating.attendees(self.sheet)
        self.assertEqual(self.groups({'tables': seating.generate(students, mentors, [])}), [('female', 'undergrad')] * 3)
        with mock.patch.object(seating, 'WALK_IN_RATE', 0):
            self.assertEqual(len(seating.generate(students, mentors, [])), 2)

    def test_contact_status_sets_how_much_each_sign_up_counts(self):
        self.add_students(10, 'female', 'grad', status='confirmed')
        self.add_students(10, 'male', 'grad', status='awaiting_response')
        self.add_students(10, 'male', 'undergrad', status='no_response')
        self.add_students(10, 'female', 'undergrad', status='not_contacted')
        self.add_students(10, 'female', 'undergrad', status='not_inviting')
        expected = {(e['gender'], e['level']): e['count'] for e in self.plan()['expected']}
        self.assertEqual(expected, {
            ('female', 'undergrad'): 0.0, ('female', 'grad'): 8.5,
            ('male', 'undergrad'): 2.0, ('male', 'grad'): 4.0,
        })

    def test_every_status_is_listed_but_only_some_count_toward_turnout(self):
        for status in ('waiting_to_contact', 'not_coming', 'no_room', 'not_inviting'):
            self.add_students(10, 'female', 'grad', status=status)
        data = self.plan()
        self.assertEqual(len(data['students']), 40)
        self.assertEqual(sum(e['count'] for e in data['expected']), 0)

    def test_no_space_is_listed_but_never_drawn_to_come(self):
        self.add_students(3, 'female', 'grad', status='confirmed')
        self.add_students(5, 'female', 'grad', status='no_space')
        data = self.plan()
        self.assertEqual(len(data['students']), 8)
        self.assertAlmostEqual(sum(e['count'] for e in data['expected']), 3 * 0.85, places=1)
        came = seating._who_comes(data['students'], 8, random.Random(1))
        self.assertEqual({s['status'] for s in came}, {'confirmed'})
        self.assertEqual(len(came), 3)
        response = self.client.post('/api/sheets/', import_body([row('k1', 'Pat', status='no_space')]), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)

    def test_new_statuses_can_be_imported(self):
        rows = [row(f'k{i}', f'P{i}', status=s) for i, s in enumerate(('waiting_to_contact', 'not_coming', 'no_room'))]
        response = self.client.post('/api/sheets/', import_body(rows), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)

    def test_tables_are_capped_by_mentors_of_that_gender(self):
        self.add_students(20, 'female', 'undergrad')
        self.add_mentor('Mia', 'female')
        self.add_mentor('Ava', 'female')
        self.assertEqual(self.groups(self.generate()), [('female', 'undergrad')] * 2)

    def test_one_mentor_for_both_levels_gets_one_shared_table(self):
        self.add_students(6, 'female', 'undergrad')
        self.add_students(6, 'female', 'grad')
        self.add_mentor('Mia', 'female')
        self.assertEqual(self.groups(self.generate()), [('female', '')])

    def test_gender_without_mentors_still_gets_tables(self):
        self.add_students(12, 'male', 'grad')
        self.assertEqual(self.groups(self.generate()), [('male', 'grad')] * 2)

    def test_no_table_gets_more_than_two_mentors(self):
        self.add_students(6, 'female', 'undergrad')  # 5.1 expected, 5.9 with walk-ins: one table
        mentors = [self.add_mentor(name, 'female') for name in ('Mia', 'Ava', 'Zoe')]
        data = self.generate()
        self.assertEqual(len(data['tables']), 1)
        seated = [m['id'] for m in data['tables'][0]['members'] if m['kind'] == 'mentor']
        self.assertEqual(len(seated), 2)
        self.assertTrue(set(seated) < {m.pk for m in mentors})

    def test_mentor_with_no_matching_tables_is_left_for_the_organizer(self):
        self.add_students(6, 'female', 'grad')
        lonely = self.add_mentor('Leo', 'male')
        data = self.generate()
        seated = {m['id'] for t in data['tables'] for m in t['members'] if m['kind'] == 'mentor'}
        self.assertNotIn(lonely.pk, seated)

    def test_mentor_marked_not_coming_is_not_seated(self):
        self.add_students(4, 'female', 'grad')
        away = self.add_mentor('Mia', 'female')
        self.save_plan({'tables': [], 'excluded_mentor_ids': [away.pk]})
        data = self.generate()
        seated = {m['id'] for t in data['tables'] for m in t['members'] if m['kind'] == 'mentor'}
        self.assertNotIn(away.pk, seated)
        self.assertEqual(data['excluded_mentor_ids'], [away.pk])

    def test_locked_students_keep_their_table_on_regenerate(self):
        students = self.add_students(16, 'female', 'undergrad')
        for name in ('Mia', 'Ava', 'Zoe', 'Ivy'):
            self.add_mentor(name, 'female')
        tables = self.generate()['tables']
        tables[1]['members'].append({'kind': 'student', 'id': students[1].id, 'locked': True})
        self.save_plan({'tables': tables})
        pinned_table = tables[1]['id']
        for _ in range(3):
            regenerated = {t['id']: t for t in self.generate()['tables']}
            self.assertIn({'kind': 'student', 'id': students[1].id, 'locked': True}, regenerated[pinned_table]['members'])

    def test_simulation_seats_who_comes_by_the_check_in_rules_and_saves_nothing(self):
        self.add_students(12, 'female', 'undergrad')
        self.add_students(5, 'male', 'grad', status='not_coming')
        unknown = self.add_students(1, '', 'undergrad')[0]
        for name, gender in (('Mia', 'female'), ('Ava', 'female'), ('Leo', 'male')):
            self.add_mentor(name, gender)
        before = self.generate()
        with mock.patch('registration.seating.random.Random', return_value=random.Random(1)):
            data = self.client.post(f'/api/sheets/{self.sheet.id}/plan/simulate/').data
        came = {s['id']: s for s in data['students'] if s['checked_in']}
        self.assertTrue(1 < len(came) <= 13)
        self.assertTrue(all(s['status'] == 'confirmed' and s['gender'] for s in came.values()))
        # 15% of the 11 expected come unexpected, on top of the sign-ups: stand-ins with ids no sign-up has.
        walk_ins = data['walk_ins']
        self.assertEqual([(s['id'], s['name'], s['checked_in']) for s in walk_ins], [(-1, 'Walk-in 1', True), (-2, 'Walk-in 2', True)])
        self.assertEqual(len(data['students']), 18)
        came.update({s['id']: s for s in walk_ins})
        if unknown.id in came:
            self.assertIn(came[unknown.id]['gender'], ('female', 'male'))
        seated = [i for ids in self.seated_students(data) for i in ids]
        self.assertEqual(len(seated), len(set(seated)))
        for table in data['tables']:
            for m in table['members']:
                if m['kind'] == 'student':
                    self.assertEqual(came[m['id']]['gender'], table['gender'])
        # No male table was planned (nobody male expected), so only girls can be seated.
        self.assertEqual(set(seated), {i for i, s in came.items() if s['gender'] == 'female'})
        self.assertEqual([t['id'] for t in data['tables']], [t['id'] for t in before['tables']])
        self.assertEqual(self.seated_students(self.plan()), [[], []])
        self.assertEqual(models.Signup.objects.filter(checked_in_at__isnull=False).count(), 0)

    def test_simulation_stops_letting_people_in_at_capacity(self):
        self.add_students(12, 'female', 'undergrad')
        self.add_mentor('Mia', 'female')
        self.generate()
        self.sheet.capacity = 3
        self.sheet.save()
        with mock.patch('registration.seating.random.Random', return_value=random.Random(1)):
            data = self.client.post(f'/api/sheets/{self.sheet.id}/plan/simulate/').data
        # Walk-ins take up spots like anyone else.
        came = [s['id'] for s in data['students'] + data['walk_ins'] if s['checked_in']]
        self.assertEqual(len(came), 3)
        self.assertGreater(data['turned_away'], 0)
        self.assertEqual(sorted(i for ids in self.seated_students(data) for i in ids), sorted(came))

    def test_simulation_can_be_given_how_many_come(self):
        self.add_students(6, 'female', 'undergrad')
        self.add_students(6, 'female', 'undergrad', status='not_coming')
        self.add_mentor('Mia', 'female')
        self.generate()
        simulate = lambda n: self.client.post(
            f'/api/sheets/{self.sheet.id}/plan/simulate/', {'attendance': n}, format='json',
        ).data
        came = [s for s in simulate(4)['students'] if s['checked_in']]
        self.assertEqual(len(came), 4)
        self.assertTrue(all(s['status'] == 'confirmed' for s in came))
        # More than are likely to come: the unlikely make up the number, up to everyone signed up.
        self.assertEqual(sum(s['checked_in'] for s in simulate(9)['students']), 9)
        self.assertEqual(sum(s['checked_in'] for s in simulate(50)['students']), 12)

    def test_first_plan_is_allowed_after_check_in_starts(self):
        student = self.add_students(6, 'female', 'grad')[0]
        self.add_mentor('Mia', 'female')
        self.check_in(student)
        self.assertEqual(self.seated_students(self.generate()), [[student.id]])

    def test_no_re_plan_once_check_in_starts(self):
        student = self.add_students(6, 'female', 'grad')[0]
        self.add_mentor('Mia', 'female')
        before = self.generate()['tables']
        self.check_in(student)
        response = self.client.post(f'/api/sheets/{self.sheet.id}/plan/generate/')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual([t['id'] for t in self.plan()['tables']], [t['id'] for t in before])

    def test_board_edits_are_validated(self):
        a, b = self.add_students(2, 'female', 'grad')
        mentor = self.add_mentor('Mia', 'female')
        other_mentor = models.Mentor.objects.create(chapter=self.other_chapter, name='X', gender='female')
        table = lambda tid, members, **group: {'id': tid, 'name': tid, 'members': members, **group}
        bodies = (
            {'tables': [table('t1', [{'kind': 'student', 'id': a.id}]), table('t2', [{'kind': 'student', 'id': a.id}])]},
            {'tables': [table('t1', [{'kind': 'student', 'id': 999999}])]},
            {'tables': [table('t1', [{'kind': 'mentor', 'id': other_mentor.pk}])]},
            {'tables': [table('t1', [{'kind': 'mentor', 'id': mentor.pk}])], 'excluded_mentor_ids': [mentor.pk]},
            {'tables': [table('t1', [], gender='other')]},
            {'tables': [table('t1', [{'kind': 'student', 'id': s.id} for s in self.add_students(7, 'female', 'grad')])]},
            {'tables': [table('t1', [{'kind': 'mentor', 'id': self.add_mentor(n, 'female').pk} for n in 'XYZ'])]},
        )
        for body in bodies:
            self.assertEqual(self.save_plan(body).status_code, status.HTTP_400_BAD_REQUEST, body)
        ok = {'tables': [table('t1', [{'kind': 'student', 'id': a.id}, {'kind': 'mentor', 'id': mentor.pk}], gender='female', level='grad')]}
        self.assertEqual(self.save_plan(ok).status_code, status.HTTP_200_OK)

    def test_board_save_keeps_seats_handed_out_since_it_was_loaded(self):
        early, late = self.add_students(2, 'female', 'grad')
        self.add_mentor('Mia', 'female')
        loaded = self.generate()
        self.check_in(late)
        tables = loaded['tables']
        tables[0]['members'].append({'kind': 'student', 'id': early.id, 'locked': True})
        saved = self.save_plan({'tables': tables, 'updated_at': loaded['updated_at']}).data
        self.assertEqual(sorted(self.seated_students(saved)[0]), sorted([early.id, late.id]))

    def test_removed_sign_ups_and_mentors_drop_off_the_saved_board(self):
        a, b = self.add_students(2, 'female', 'grad')
        mentor = self.add_mentor('Mia', 'female')
        self.generate()
        self.check_in(a)
        self.check_in(b)
        b.delete()
        mentor.delete()
        data = self.plan()
        self.assertEqual(self.seated_students(data), [[a.id]])
        self.assertEqual(data['tables'][0]['members'], [{'kind': 'student', 'id': a.id, 'locked': False}])


class ScoringTests(SeatingBase):
    GIRL, GUY, GRAD_GIRL = ('female', 'undergrad'), ('male', 'undergrad'), ('female', 'grad')

    def score(self, mentors, came, gender='female', level='undergrad'):
        """The points, by cause, for one table led by that many mentors where `came` sit, each a (gender, level)."""
        students = [{'id': i, 'gender': g, 'level': l} for i, (g, l) in enumerate(came)]
        members = [{'kind': 'mentor', 'id': i} for i in range(mentors)]
        members += [{'kind': 'student', 'id': s['id']} for s in students]
        points = seating.score_room([{'gender': gender, 'level': level, 'members': members}], students)
        return {cause: n for cause, n in points.items() if n}

    def test_a_crowded_table_costs_more_the_fewer_mentors_it_has(self):
        self.assertEqual(self.score(1, [self.GIRL] * 3), {'lone_mentor': 1})
        self.assertEqual(self.score(2, [self.GIRL] * 6), {})
        self.assertEqual(self.score(1, [self.GIRL] * 5), {'past_ideal': 4, 'lone_mentor': 1})
        self.assertEqual(self.score(2, [self.GIRL] * 7), {'past_max': 5})
        self.assertEqual(self.score(1, [self.GIRL] * 7), {'past_ideal': 6, 'past_max': 5, 'lone_mentor': 1})
        # One table of 8 is worse than two of 7.
        self.assertEqual(self.score(2, [self.GIRL] * 8), {'past_max': 20})

    def test_sitting_alone_or_with_the_other_level_costs_points(self):
        self.assertEqual(self.score(1, [self.GIRL]), {'alone': 4, 'lone_mentor': 1})
        self.assertEqual(self.score(1, []), {'empty_table': 1})
        self.assertEqual(self.score(0, []), {})
        self.assertEqual(self.score(2, [self.GIRL, self.GUY, self.GUY], gender='coed'), {'lone_gender': 3})
        self.assertEqual(self.score(2, [self.GIRL, self.GIRL, self.GRAD_GIRL]), {'other_level': 1})
        self.assertEqual(self.score(2, [self.GIRL, self.GIRL, self.GRAD_GIRL], level=''), {'other_level': 1})

    def test_students_with_no_table_cost_the_most(self):
        came = [{'id': i, 'gender': 'male', 'level': 'grad'} for i in range(2)]
        self.assertEqual(seating.score_room([], came)['no_table'], 20)

    def score_plan(self):
        return self.client.get(f'/api/sheets/{self.sheet.id}/plan/score/').data

    def test_plan_is_scored_over_turnouts_around_the_expected_one_and_saves_nothing(self):
        self.add_students(12, 'female', 'undergrad')  # 10.2 expected
        self.add_mentor('Mia', 'female')
        self.generate()
        data = self.score_plan()
        # 5 either side of 10, but no more than signed up, and 2 walk-ins every day.
        self.assertEqual((data['turnout'], data['days']), ([7, 14], 8 * seating.DAYS_PER_TURNOUT))
        # One mentor for everyone: every day has students past 3 per mentor.
        self.assertGreater(data['causes']['past_ideal'], 0)
        self.assertGreaterEqual(data['worst'], data['average'])
        self.assertAlmostEqual(sum(data['causes'].values()), data['average'], delta=0.5)
        # The same pretend days each time.
        self.assertEqual(self.score_plan(), data)
        self.assertEqual(self.seated_students(self.plan()), [[]])
        self.assertEqual(models.Signup.objects.filter(checked_in_at__isnull=False).count(), 0)

    def test_every_pretend_day_has_walk_ins_in_the_expected_mix(self):
        self.add_students(20, 'female', 'undergrad')  # 17 expected
        self.add_students(4, 'male', 'grad')  # 3.4 expected
        students, _ = seating.attendees(self.sheet)
        days = seating.pretend_days(students, None, random.Random(1))
        signed_up = {s['id'] for s in students}
        walk_ins = [[s for s in came if s['id'] not in signed_up] for came in days]
        # 15% of the 20 expected, whatever the day's turnout.
        self.assertEqual({len(day) for day in walk_ins}, {3})
        self.assertTrue(all(s['id'] < 0 for day in walk_ins for s in day))
        groups = Counter((s['gender'], s['level']) for day in walk_ins for s in day)
        self.assertEqual(set(groups), {('female', 'undergrad'), ('male', 'grad')})
        self.assertGreater(groups[('female', 'undergrad')], groups[('male', 'grad')])

    def test_walk_ins_are_turned_away_at_capacity_like_anyone_else(self):
        self.add_students(20, 'female', 'undergrad')
        students, _ = seating.attendees(self.sheet)
        self.assertTrue(all(len(came) <= 10 for came in seating.pretend_days(students, 10, random.Random(1))))

    def test_more_mentors_score_better(self):
        self.add_students(12, 'female', 'undergrad')
        self.add_mentor('Mia', 'female')
        self.generate()
        short_staffed = self.score_plan()['average']
        for name in ('Ava', 'Zoe', 'Ivy'):
            self.add_mentor(name, 'female')
        self.generate()
        self.assertLess(self.score_plan()['average'], short_staffed)


    def mentors_by_table(self, data):
        names = {m['id']: m['name'] for m in data['mentors']}
        return [(t['gender'], sorted(names[m['id']] for m in t['members'] if m['kind'] == 'mentor')) for t in data['tables']]

    def test_re_plan_opens_a_table_for_spare_mentors_when_the_days_call_for_it(self):
        # 10.2 expected, 11.7 with walk-ins: two tables, too few when 13 or 14 come
        self.add_students(12, 'female', 'undergrad')
        for name in ('Mia', 'Ava', 'Zoe', 'Ivy', 'Amy', 'Eve'):
            self.add_mentor(name, 'female')
        students, mentors = seating.attendees(self.sheet)
        self.assertEqual(len(seating.generate(students, mentors, [])), 2)
        data = self.generate()
        self.assertEqual(self.groups(data), [('female', 'undergrad')] * 3)
        self.assertEqual([len(mentors) for _, mentors in self.mentors_by_table(data)], [2, 2, 2])
        self.assertEqual(self.seated_students(data), [[], [], []])
        self.assertEqual(self.score_plan()['average'], 0)

    def test_re_plan_makes_a_coed_table_when_it_scores_better(self):
        self.add_students(4, 'female', 'undergrad')
        self.add_students(14, 'male', 'undergrad')
        for name, gender in (('Ann Lee', 'female'), ('Mia Stone', 'female'), ('Tom Lee', 'male'), ('Sam Park', 'male')):
            self.add_mentor(name, gender)
        students, mentors = seating.attendees(self.sheet)
        days = seating.pretend_days(students, self.sheet.capacity, random.Random(self.sheet.id))
        draft = seating.evaluate(seating.generate(students, mentors, []), students, days)['average']
        data = self.generate()
        # The guys' two tables had a mentor each; Ann joins her husband's, so it can take six.
        self.assertIn(('coed', ['Ann Lee', 'Tom Lee']), self.mentors_by_table(data))
        self.assertLess(self.score_plan()['average'], draft)

    def test_re_plan_merges_two_small_tables_into_one_for_both_levels(self):
        self.add_students(3, 'female', 'undergrad')
        self.add_students(2, 'female', 'grad')
        for name in ('Mia', 'Ava'):
            self.add_mentor(name, 'female')
        students, mentors = seating.attendees(self.sheet)
        self.assertEqual(len(seating.generate(students, mentors, [])), 2)
        # A table each would often leave one grad sitting alone.
        data = self.generate()
        self.assertEqual(self.groups(data), [('female', '')])
        self.assertEqual(self.mentors_by_table(data), [('female', ['Ava', 'Mia'])])

    def test_re_plan_logs_how_it_picked_the_tables_without_naming_anyone(self):
        self.add_students(3, 'female', 'undergrad')
        self.add_students(2, 'female', 'grad')
        for name in ('Mia', 'Ava'):
            self.add_mentor(name, 'female')
        with self.assertLogs('registration.seating', 'INFO') as logs:
            self.generate()
        log = '\n'.join(logs.output)
        self.assertIn('found: the first plan', log)
        self.assertRegex(log, r'merge a female undergrad table and a female grad table: .* -> better, kept')
        self.assertRegex(log, r'chosen: .*\n.*1 tables: female either level 2')
        self.assertNotRegex(log, 'Mia|Ava')

    def test_re_plan_keeps_locked_people_and_the_plan_as_drawn_when_nothing_scores_better(self):
        students = self.add_students(6, 'female', 'grad')
        mentor = self.add_mentor('Mia', 'female')
        tables = self.generate()['tables']
        tables[0]['members'] = [
            {'kind': 'mentor', 'id': mentor.id, 'locked': True}, {'kind': 'student', 'id': students[0].id, 'locked': True},
        ]
        self.save_plan({'tables': tables})
        data = self.generate()
        self.assertEqual(self.groups(data), [('female', 'grad')])
        self.assertEqual(data['tables'][0]['members'], tables[0]['members'])


class CoedTableTests(SeatingBase):
    def simulate(self, attendance):
        return self.client.post(
            f'/api/sheets/{self.sheet.id}/plan/simulate/', {'attendance': attendance}, format='json',
        ).data

    def by_group(self, data):
        genders = {s['id']: s['gender'] for s in data['students']}
        names = {m['id']: m['name'] for m in data['mentors']} if 'mentors' in data else {}
        return [
            (
                t['gender'],
                Counter(genders[m['id']] for m in t['members'] if m['kind'] == 'student'),
                sorted(names.get(m['id'], m['id']) for m in t['members'] if m['kind'] == 'mentor'),
            )
            for t in data['tables']
        ]

    def crowded_guys_and_a_couple(self):
        """Ann and Mia at one girls table of 4, and Tom and Sam at a guys table of 4 each."""
        self.girls = self.add_students(4, 'female', 'undergrad')
        self.add_students(8, 'male', 'undergrad')
        for name, gender in (('Ann Lee', 'female'), ('Mia Stone', 'female'), ('Tom Lee', 'male'), ('Sam Park', 'male')):
            self.add_mentor(name, gender)
        # Planned without walk-ins: with them Re-plan makes the coed table itself, and the simulation has nothing to ease.
        with mock.patch.object(seating, 'WALK_IN_RATE', 0):
            return self.generate()

    def test_simulation_brings_a_couple_together_at_a_coed_table(self):
        plan = self.crowded_guys_and_a_couple()
        self.assertEqual(self.groups(plan), [('female', 'undergrad')] + [('male', 'undergrad')] * 2)
        with mock.patch.object(seating, 'WALK_IN_RATE', 0):
            data = {**self.simulate(12), 'mentors': plan['mentors']}
        # Ann joins Tom: his guys table was past 3 per mentor, and hers has Mia.
        moves = data['rearranged']
        self.assertEqual((moves['coed_tables'], moves['tables_added'], moves['mentors_moved']), (1, 0, 1))
        self.assertGreater(moves['students_moved'], 0)
        groups = self.by_group(data)
        self.assertEqual(sorted(mentors for gender, _, mentors in groups if gender != 'male'), [['Ann Lee', 'Tom Lee'], ['Mia Stone']])
        self.assertEqual(sum(sum(counts.values()) for _, counts, _ in groups), 12)
        # Nothing is saved.
        self.assertEqual(self.groups(self.plan()), self.groups(plan))

    def test_no_simulation_once_check_in_starts(self):
        self.crowded_guys_and_a_couple()
        self.check_in(self.girls[0])
        response = self.client.post(f'/api/sheets/{self.sheet.id}/plan/simulate/', {'attendance': 12}, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    STAFF = [(1, 'Ann Lee', 'female'), (2, 'Mia Stone', 'female'), (3, 'Tom Lee', 'male'), (4, 'Sam Park', 'male')]

    def rebalance(self, tables, girls, guys, staff=STAFF, change=None, **kwargs):
        """Seats `girls` then `guys` (how many of each, all undergrad) by the check-in rule at
        `tables`, given as (gender, mentor ids) and all undergrad, and rebalances. Returns the
        tables, each student's gender, and what rebalance did."""
        tables = [
            {'id': str(i), 'name': str(i), 'gender': gender, 'level': 'undergrad',
             'members': [{'kind': 'mentor', 'id': m, 'locked': False} for m in mentor_ids]}
            for i, (gender, mentor_ids) in enumerate(tables)
        ]
        students = [
            {'id': 10 + i, 'gender': 'female' if i < girls else 'male', 'level': 'undergrad'} for i in range(girls + guys)
        ]
        if change:
            change(tables, students)
        mentors = [{'id': i, 'name': name, 'gender': gender} for i, name, gender in staff]
        result = seating.rebalance(tables, students, mentors, **kwargs)
        return tables, {s['id']: s['gender'] for s in students}, result

    def sizes(self, tables):
        return [(t['gender'], seating._count(t, 'mentor'), seating._count(t, 'student')) for t in tables]

    def mentor_ids(self, tables):
        return [[m['id'] for m in t['members'] if m['kind'] == 'mentor'] for t in tables]

    WIFE_ALONE = [('female', [1]), ('female', [2]), ('male', [3, 4])]

    def test_spouse_joins_and_the_table_goes_coed(self):
        # Ann and Mia each lead a girls table; Tom and Sam share the guys.
        tables, genders, result = self.rebalance(self.WIFE_ALONE, girls=11, guys=3)
        # Tom joins Ann: their table now takes 6 girls, and Sam can lead 3 guys alone.
        self.assertEqual(self.sizes(tables), [('coed', 2, 6), ('female', 1, 5), ('male', 1, 3)])
        self.assertEqual(self.mentor_ids(tables), [[1, 3], [2], [4]])
        self.assertEqual({k: result[k] for k in ('coed_tables', 'tables_added', 'mentors_seated', 'mentors_moved')}, {
            'coed_tables': 1, 'tables_added': 0, 'mentors_seated': 0, 'mentors_moved': 1,
        })

    def test_coed_table_takes_the_gender_short_of_room_two_or_more_at_a_time(self):
        staff = [self.STAFF[0], *self.STAFF[2:]]
        tables, genders, result = self.rebalance([('female', [1]), ('male', [3, 4])], girls=4, guys=5, staff=staff)
        # Tom joins Ann. Sam can lead 3 guys alone, so the other 2 go to the coed table.
        self.assertEqual(self.sizes(tables), [('coed', 2, 6), ('male', 1, 3)])
        self.assertEqual(self.mentor_ids(tables), [[1, 3], [4]])
        self.assertEqual(seating._gender_counts(tables[0], genders), {'female': 4, 'male': 2})

    def test_mentor_who_makes_way_for_a_spouse_joins_a_crowded_table(self):
        tables, genders, result = self.rebalance(
            [('female', [1, 2]), ('female', [5]), ('male', [3, 4])], girls=11, guys=3,
            staff=[*self.STAFF, (5, 'Zoe Kim', 'female')],
        )
        self.assertEqual(self.mentor_ids(tables), [[1, 3], [5, 2], [4]])
        self.assertEqual(self.sizes(tables), [('coed', 2, 5), ('female', 2, 6), ('male', 1, 3)])
        self.assertEqual(result['mentors_moved'], 2)

    def test_no_coed_table_without_a_couple(self):
        staff = [(1, 'Ann Cho', 'female'), *self.STAFF[1:]]
        tables, genders, result = self.rebalance(self.WIFE_ALONE, girls=11, guys=3, staff=staff)
        self.assertEqual(self.sizes(tables), [('female', 1, 6), ('female', 1, 5), ('male', 2, 3)])
        self.assertEqual(result['coed_tables'], 0)

    def test_couple_stays_apart_when_coming_together_would_not_help(self):
        for tables, girls, guys, staff in (
            ([('female', [1]), ('male', [3, 4])], 3, 4, self.STAFF),  # nobody is past 3 per mentor
            ([('female', [1]), ('male', [3])], 4, 5, [self.STAFF[0], self.STAFF[2]]),  # nobody to take over his table
        ):
            before = [mentor_ids for _, mentor_ids in tables]
            tables, genders, result = self.rebalance(tables, girls, guys, staff)
            self.assertEqual(self.mentor_ids(tables), before)
            self.assertEqual(result['coed_tables'], 0)

    def test_coed_tables_are_one_level_only(self):
        def either_level(tables, students):
            tables[0]['level'] = ''

        def grad_who_stays(tables, students):
            students[0]['level'] = 'grad'
            tables[0]['members'].append({'kind': 'student', 'id': students[0]['id'], 'locked': False})

        run = lambda **kwargs: self.rebalance(self.WIFE_ALONE, girls=11, guys=3, **kwargs)
        # A table for either level can't go coed: Ann's stays, and she can't leave it for Tom's.
        self.assertEqual(run(change=either_level)[2]['coed_tables'], 0)
        # Nor one where a grad sits who was really checked in.
        self.assertEqual(run(change=grad_who_stays, fixed={10})[2]['coed_tables'], 0)
        # A grad who only spilled in there is re-seated, and not at the coed table.
        tables, genders, result = run(change=grad_who_stays)
        self.assertEqual(result['coed_tables'], 1)
        self.assertEqual([t['gender'] for t in tables if seating.table_of([t], 'student', 10)], ['female'])

    def test_spare_mentor_joins_a_crowded_table_of_their_gender_with_a_free_seat(self):
        tables, genders, result = self.rebalance([('male', [3])], girls=0, guys=6)
        self.assertEqual(self.sizes(tables), [('male', 2, 6)])
        self.assertEqual((result['mentors_seated'], result['tables_added']), (1, 0))

    def test_spare_mentor_opens_a_table_for_their_own_genders_extra_students(self):
        staff = [*self.STAFF, (6, 'Dan Wu', 'male')]
        tables, genders, result = self.rebalance([('male', [3, 4])], girls=0, guys=9, staff=staff)
        self.assertEqual(self.sizes(tables), [('male', 2, 6), ('male', 1, 3)])
        self.assertEqual(result['tables_added'], 1)
        self.assertEqual(tables[1]['level'], 'undergrad')

    def test_spare_mentor_does_not_open_a_table_for_the_other_gender(self):
        staff = [self.STAFF[1], *self.STAFF[2:], (6, 'Dan Wu', 'male')]
        tables, genders, result = self.rebalance([('female', [2]), ('male', [3, 4])], girls=7, guys=6, staff=staff)
        self.assertEqual(self.sizes(tables), [('female', 1, 7), ('male', 2, 6)])
        self.assertEqual((result['tables_added'], result['mentors_seated']), (0, 0))

    def test_nobody_spills_into_a_coed_table_of_the_other_level(self):
        mentor = lambda i: {'kind': 'mentor', 'id': i}
        tables = [
            {'id': 'a', 'gender': 'female', 'level': 'grad', 'members': [mentor(1), *[{'kind': 'student', 'id': i} for i in range(10, 17)]]},
            {'id': 'b', 'gender': 'coed', 'level': 'undergrad', 'members': [mentor(2), mentor(3)]},
        ]
        genders = {i: 'female' for i in range(10, 17)}
        self.assertEqual(seating.pick_table(tables, {'gender': 'female', 'level': 'grad'}, genders), 0)
        self.assertEqual(seating.pick_table(tables, {'gender': 'female', 'level': 'undergrad'}, genders), 1)
        self.assertEqual(seating.pick_table(tables, {'gender': 'male', 'level': 'grad'}, genders), None)

    def test_coed_table_needs_a_level(self):
        body = {'tables': [{'id': 't1', 'name': 'T', 'gender': 'coed', 'level': '', 'members': []}]}
        self.assertEqual(self.save_plan(body).status_code, status.HTTP_400_BAD_REQUEST)
        body['tables'][0]['level'] = 'grad'
        self.assertEqual(self.save_plan(body).status_code, status.HTTP_200_OK)

    def test_coed_table_can_be_saved_and_seats_both_at_check_in(self):
        girls = self.add_students(4, 'female', 'undergrad')
        guys = self.add_students(4, 'male', 'undergrad')
        self.add_mentor('Ann Lee', 'female')
        self.add_mentor('Tom Lee', 'male')
        data = self.generate()
        ann, tom = [m for t in data['tables'] for m in t['members']]
        coed = {**data['tables'][0], 'gender': 'coed', 'members': [ann, tom]}
        self.assertEqual(self.save_plan({'tables': [coed]}).status_code, status.HTTP_200_OK)
        for person in (girls[0], girls[1], girls[2], guys[0], guys[1], guys[2], girls[3], guys[3]):
            self.assertEqual(self.check_in(person)['table']['id'], coed['id'])
        seated = self.seated_students(self.plan())[0]
        # Two seats were held for the guys while only girls had come.
        self.assertEqual(len(seated), 8)

    def test_nobody_should_be_the_only_one_of_their_gender_at_a_coed_table(self):
        mentor = lambda i: {'kind': 'mentor', 'id': i}
        seats = lambda ids: [{'kind': 'student', 'id': i} for i in ids]
        coed = {'id': 'a', 'gender': 'coed', 'level': 'undergrad', 'members': [mentor(1), mentor(2)]}
        girls_table = {'id': 'b', 'gender': 'female', 'level': 'undergrad', 'members': [mentor(3), *seats(range(20, 25))]}
        guys_table = {'id': 'c', 'gender': 'male', 'level': 'undergrad', 'members': [mentor(4), *seats(range(30, 34))]}
        genders = {**{i: 'female' for i in range(10, 30)}, **{i: 'male' for i in range(30, 40)}}
        girl = {'gender': 'female', 'level': 'undergrad'}
        guy = {'gender': 'male', 'level': 'undergrad'}
        pick = lambda student, ids: seating.pick_table(
            [{**coed, 'members': coed['members'] + seats(ids)}, girls_table, guys_table], student, genders,
        )
        # 5 girls: one seat left, so a guy would have no second guy to follow him.
        self.assertEqual((pick(girl, range(10, 15)), pick(guy, range(10, 15))), (0, 2))
        # 4 girls: a guy can join, and the last seat is then kept for a second guy.
        self.assertEqual(pick(guy, range(10, 14)), 0)
        self.assertEqual((pick(girl, [*range(10, 14), 35]), pick(guy, [*range(10, 14), 35])), (1, 0))

    def test_coed_table_is_the_second_choice_of_two_equally_full_tables(self):
        tables = [
            {'id': 'a', 'gender': 'coed', 'level': 'undergrad', 'members': [{'kind': 'mentor', 'id': 1}, {'kind': 'mentor', 'id': 2}]},
            {'id': 'b', 'gender': 'female', 'level': 'undergrad', 'members': [{'kind': 'mentor', 'id': 3}]},
        ]
        self.assertEqual(seating.pick_table(tables, {'gender': 'female', 'level': 'undergrad'}), 1)


class NotAStudentTests(SeatingBase):
    def test_other_is_listed_but_not_planned_for(self):
        self.add_students(10, 'female', 'other')
        data = self.plan()
        self.assertEqual([s['level'] for s in data['students']], ['other'] * 10)
        self.assertEqual(sum(e['count'] for e in data['expected']), 0)
        self.assertEqual(self.generate()['tables'], [])

    def test_other_checked_in_sits_at_either_level(self):
        self.add_students(3, 'female', 'grad')
        guest = self.add_students(1, 'female', 'other')[0]
        self.add_mentor('Mia', 'female')
        self.generate()
        self.assertEqual(self.check_in(guest)['table']['name'], 'Table 1')

    def test_tables_cannot_be_grouped_as_other(self):
        body = {'tables': [{'id': 't1', 'name': 'T', 'gender': 'female', 'level': 'other', 'members': []}]}
        self.assertEqual(self.save_plan(body).status_code, status.HTTP_400_BAD_REQUEST)

    def test_other_can_be_imported(self):
        response = self.client.post('/api/sheets/', import_body([row('k1', 'Pat', 'male', 'other')]), format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)


class CheckInSeatingTests(SeatingBase):
    def test_check_in_keeps_tables_even_then_squeezes_in_rather_than_add_a_table(self):
        students = self.add_students(13, 'female', 'undergrad', status='not_contacted')
        self.add_students(12, 'female', 'undergrad')  # 10.2 expected: two tables
        for name in ('Mia', 'Ava', 'Zoe', 'Ivy'):
            self.add_mentor(name, 'female')
        self.generate()
        sizes = lambda: [len(t) for t in self.seated_students(self.plan())]
        for s in students[:3]:
            self.check_in(s)
        self.assertEqual(sizes(), [2, 1])
        for s in students[3:7]:
            self.check_in(s)
        self.assertEqual(sizes(), [4, 3])
        for s in students[7:12]:
            self.check_in(s)
        self.assertEqual(sizes(), [6, 6])
        # Nobody starts a new table alone: they take a 7th seat at Table 1.
        self.assertEqual(self.check_in(students[12])['table']['name'], 'Table 1')
        self.assertEqual(sizes(), [7, 6])

    def test_board_save_keeps_a_table_check_in_took_past_six_but_no_fuller(self):
        students = self.add_students(8, 'female', 'grad')
        self.add_mentor('Mia', 'female')
        self.generate()
        for s in students[:7]:
            self.check_in(s)
        data = self.plan()
        self.assertEqual(self.save_plan({'tables': data['tables']}).status_code, status.HTTP_200_OK)
        data['tables'][0]['members'].append({'kind': 'student', 'id': students[7].id, 'locked': True})
        self.assertEqual(self.save_plan({'tables': data['tables']}).status_code, status.HTTP_400_BAD_REQUEST)

    def test_table_at_three_per_mentor_waits_while_another_of_its_level_fills(self):
        students = self.add_students(13, 'female', 'undergrad', status='not_contacted')
        self.add_students(12, 'female', 'undergrad')  # 10.2 expected: two tables
        for name in ('Mia', 'Ava', 'Zoe'):
            self.add_mentor(name, 'female')
        self.generate()  # Table 1 gets two mentors, Table 2 one
        sizes = lambda: [len(t) for t in self.seated_students(self.plan())]
        for s in students[:6]:
            self.check_in(s)
        self.assertEqual(sizes(), [3, 3])
        for s in students[6:9]:
            self.check_in(s)
        self.assertEqual(sizes(), [6, 3])
        # Both at 3 per mentor and no other level to spill into: even again.
        for s in students[9:12]:
            self.check_in(s)
        self.assertEqual(sizes(), [6, 6])
        self.check_in(students[12])
        self.assertEqual(sizes(), [7, 6])

    def test_spills_into_the_other_level_once_their_own_is_at_three_per_mentor(self):
        undergrads = self.add_students(8, 'female', 'undergrad', status='not_contacted')
        self.add_students(4, 'female', 'undergrad')
        self.add_students(3, 'female', 'grad')
        self.add_mentor('Mia', 'female')
        self.add_mentor('Ava', 'female')
        data = self.generate()
        own, other = [next(t['id'] for t in data['tables'] if t['level'] == level) for level in ('undergrad', 'grad')]
        tables = [self.check_in(s)['table']['id'] for s in undergrads]
        # Then both are at 3 per mentor, and the rest spread evenly across the gender's tables.
        self.assertEqual(tables, [own] * 3 + [other] * 3 + [own, other])

    def test_check_in_response_names_the_table_and_mentor(self):
        student = self.add_students(3, 'female', 'grad')[0]
        self.add_mentor('Mia Chen', 'female')
        self.generate()
        data = self.check_in(student)
        self.assertEqual((data['table']['name'], data['table']['mentors']), ('Table 1', ['Mia Chen']))
        self.assertTrue(data['student']['checked_in'])

    def test_never_seated_at_the_other_genders_table(self):
        self.add_students(6, 'female', 'grad')
        guy = self.add_students(1, 'male', 'grad', status='not_contacted')[0]
        self.generate()
        data = self.check_in(guy)
        self.assertTrue(data['student']['checked_in'])
        self.assertIsNone(data['table'])

    def test_door_fills_in_gender_and_level_the_sheet_missed(self):
        self.add_students(3, 'female', 'grad')
        unknown = self.add_students(1, '', '')[0]
        self.add_mentor('Mia', 'female')
        self.generate()
        self.assertIsNone(self.check_in(unknown)['table'])
        data = self.check_in(unknown, gender='female', level='grad')
        self.assertEqual(data['table']['name'], 'Table 1')
        unknown.refresh_from_db()
        self.assertEqual((unknown.door_gender, unknown.door_level), ('female', 'grad'))

    def test_undo_check_in_frees_the_seat_but_not_a_locked_one(self):
        loose, pinned = self.add_students(2, 'female', 'grad')
        self.add_mentor('Mia', 'female')
        self.generate()
        self.check_in(loose)
        tables = self.plan()['tables']
        tables[0]['members'].append({'kind': 'student', 'id': pinned.id, 'locked': True})
        self.save_plan({'tables': tables})
        self.check_in(pinned)
        for s in (loose, pinned):
            self.client.post(f'/api/signups/{s.id}/undo-check-in/')
        self.assertEqual(self.seated_students(self.plan()), [[pinned.id]])

    def test_nobody_is_seated_at_a_table_without_a_mentor(self):
        girls = self.add_students(8, 'female', 'grad')
        self.assertEqual(self.groups(self.generate()), [('female', 'grad')] * 2)
        self.assertIsNone(self.check_in(girls[0])['table'])
        # With a mentor at one table, everyone goes there, past 6 too.
        mia = self.add_mentor('Mia', 'female')
        tables = self.plan()['tables']
        tables[1]['members'].append({'kind': 'mentor', 'id': mia.id, 'locked': False})
        self.assertEqual(self.save_plan({'tables': tables}).status_code, status.HTTP_200_OK)
        self.assertEqual({self.check_in(girl)['table']['id'] for girl in girls[1:]}, {tables[1]['id']})
        # And the board can't take the mentor away from them, or seat a student where there is none.
        seated = self.plan()['tables']
        without_mentor = [seated[0], {**seated[1], 'members': [m for m in seated[1]['members'] if m['kind'] == 'student']}]
        self.assertEqual(self.save_plan({'tables': without_mentor}).status_code, status.HTTP_400_BAD_REQUEST)
        moved = seated[1]['members'][-1]
        at_empty_table = [
            {**seated[0], 'members': [moved]}, {**seated[1], 'members': [m for m in seated[1]['members'] if m != moved]},
        ]
        self.assertEqual(self.save_plan({'tables': at_empty_table}).status_code, status.HTTP_400_BAD_REQUEST)

    def test_guys_never_sit_with_girls_of_the_other_level(self):
        girls = {level: self.add_students(4, 'female', level)[0] for level in ('undergrad', 'grad')}
        guys = {level: self.add_students(4, 'male', level)[0] for level in ('undergrad', 'grad')}
        self.add_mentor('Ann Lee', 'female')
        self.add_mentor('Tom Lee', 'male')
        tables = self.generate()['tables']
        seat = lambda *students: self.save_plan({'tables': [
            {**tables[0], 'gender': 'coed', 'level': 'undergrad', 'members': tables[0]['members'] + [
                {'kind': 'student', 'id': s.id, 'locked': True} for s in students
            ]},
            *tables[1:],
        ]}).status_code
        self.assertEqual(seat(girls['undergrad'], guys['grad']), status.HTTP_400_BAD_REQUEST)
        self.assertEqual(seat(girls['grad'], guys['undergrad']), status.HTTP_400_BAD_REQUEST)
        self.assertEqual(seat(girls['undergrad'], guys['undergrad']), status.HTTP_200_OK)

    def test_check_in_records_who_did_it(self):
        student = self.add_students(1, 'female', 'grad')[0]
        self.check_in(student)
        student.refresh_from_db()
        self.assertEqual(student.checked_in_by, self.user)


class FrontendTests(SimpleTestCase):
    def setUp(self):
        self.dist = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dist)
        (self.dist / 'index.html').write_text('<div id="root"></div>')

    def test_page_paths_get_the_app(self):
        with override_settings(FRONTEND_DIST=self.dist):
            for path in ('/', '/sheets/12', '/mentors'):
                response = self.client.get(path)
                self.assertEqual(response.status_code, status.HTTP_200_OK, path)
                self.assertContains(response, 'id="root"')
                self.assertEqual(response['Cache-Control'], 'no-cache')

    def test_unknown_api_paths_still_404(self):
        with override_settings(FRONTEND_DIST=self.dist):
            self.assertEqual(self.client.get('/api/nope/').status_code, status.HTTP_404_NOT_FOUND)

    def test_without_a_build_pages_404(self):
        with override_settings(FRONTEND_DIST=self.dist / 'missing'):
            self.assertEqual(self.client.get('/sheets/12').status_code, status.HTTP_404_NOT_FOUND)

    def test_pages_carry_a_content_security_policy(self):
        with override_settings(FRONTEND_DIST=self.dist, CSP_REPORT_ONLY=False):
            policy = self.client.get('/')['Content-Security-Policy']
        self.assertIn("default-src 'self'", policy)
        self.assertIn('https://accounts.google.com/gsi/client', policy)
        with override_settings(FRONTEND_DIST=self.dist, CSP_REPORT_ONLY=True):
            response = self.client.get('/')
        self.assertIn('Content-Security-Policy-Report-Only', response.headers)
        self.assertNotIn('Content-Security-Policy', response.headers)
