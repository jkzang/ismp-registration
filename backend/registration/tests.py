import random
import shutil
import tempfile
from datetime import timedelta
from pathlib import Path
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from . import models
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
        'starts_at': '2026-10-01T19:00:00Z', 'capacity': 60, **extra,
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

    def test_import_needs_the_event_start_and_capacity(self):
        for missing in ('starts_at', 'capacity'):
            body = import_body([row('k1', 'Amy')])
            del body[missing]
            response = self.client.post('/api/sheets/', body, format='json')
            self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST, missing)
            self.assertIn(missing, response.data)
        response = self.client.post('/api/sheets/', import_body([row('k1', 'Amy')], capacity=0), format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        response = self.client.post('/api/sheets/', import_body([row('k1', 'Amy')], capacity=45), format='json')
        self.assertEqual((response.data['capacity'], response.data['starts_at']), (45, '2026-10-01T19:00:00Z'))

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
        self.add_students(7, 'female', 'undergrad')  # 5.95 expected: one table
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
        girls = self.add_students(12, 'female', 'undergrad')
        self.add_students(5, 'male', 'grad', status='not_coming')
        unknown = self.add_students(1, '', 'undergrad')[0]
        for name, gender in (('Mia', 'female'), ('Ava', 'female'), ('Leo', 'male')):
            self.add_mentor(name, gender)
        before = self.generate()
        self.check_in(girls[0])
        with mock.patch('registration.seating.random.Random', return_value=random.Random(1)):
            data = self.client.post(f'/api/sheets/{self.sheet.id}/plan/simulate/').data
        came = {s['id']: s for s in data['students'] if s['checked_in']}
        self.assertIn(girls[0].id, came)
        self.assertTrue(1 < len(came) <= 13)
        self.assertTrue(all(s['status'] == 'confirmed' and s['gender'] for s in came.values()))
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
        self.assertEqual(self.seated_students(self.plan()), [[girls[0].id], []])
        self.assertEqual(models.Signup.objects.filter(checked_in_at__isnull=False).count(), 1)

    def test_simulation_stops_letting_people_in_at_capacity(self):
        girls = self.add_students(12, 'female', 'undergrad')
        self.add_mentor('Mia', 'female')
        self.generate()
        self.check_in(girls[0])
        self.sheet.capacity = 3
        self.sheet.save()
        with mock.patch('registration.seating.random.Random', return_value=random.Random(1)):
            data = self.client.post(f'/api/sheets/{self.sheet.id}/plan/simulate/').data
        came = [s['id'] for s in data['students'] if s['checked_in']]
        self.assertEqual(len(came), 3)
        self.assertIn(girls[0].id, came)
        self.assertGreater(data['turned_away'], 0)
        self.assertEqual(sorted(i for ids in self.seated_students(data) for i in ids), sorted(came))

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

    def test_levels_stay_apart_even_past_four(self):
        undergrads = self.add_students(5, 'female', 'undergrad', status='not_contacted')
        self.add_students(4, 'female', 'undergrad')
        self.add_students(3, 'female', 'grad')
        self.add_mentor('Mia', 'female')
        self.add_mentor('Ava', 'female')
        data = self.generate()
        grad_table = next(t['id'] for t in data['tables'] if t['level'] == 'grad')
        tables = {self.check_in(s)['table']['id'] for s in undergrads}
        self.assertEqual(len(tables), 1)
        self.assertNotIn(grad_table, tables)

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
        self.generate()
        self.assertIsNone(self.check_in(unknown)['table'])
        data = self.check_in(unknown, gender='female', level='grad')
        self.assertEqual(data['table']['name'], 'Table 1')
        unknown.refresh_from_db()
        self.assertEqual((unknown.door_gender, unknown.door_level), ('female', 'grad'))

    def test_undo_check_in_frees_the_seat_but_not_a_locked_one(self):
        loose, pinned = self.add_students(2, 'female', 'grad')
        self.generate()
        self.check_in(loose)
        tables = self.plan()['tables']
        tables[0]['members'].append({'kind': 'student', 'id': pinned.id, 'locked': True})
        self.save_plan({'tables': tables})
        self.check_in(pinned)
        for s in (loose, pinned):
            self.client.post(f'/api/signups/{s.id}/undo-check-in/')
        self.assertEqual(self.seated_students(self.plan()), [[pinned.id]])

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
