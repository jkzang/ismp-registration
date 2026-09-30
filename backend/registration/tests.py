from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import override_settings
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
        'tab_title': 'Form Responses 1', 'field_map': {'name': 'First & Last Name'}, 'rows': rows, **extra,
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
        response = self.client.post('/api/sheets/', import_body([], field_map={'email': 'Email'}), format='json')
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

    def test_capacity_is_the_only_editable_field(self):
        sheet = self.import_sheet([])
        response = self.client.patch(f'/api/sheets/{sheet.id}/', {'capacity': 40, 'tab_title': 'x'}, format='json')
        self.assertEqual((response.data['capacity'], response.data['tab_title']), (40, 'Form Responses 1'))
        response = self.client.patch(f'/api/sheets/{sheet.id}/', {'capacity': None}, format='json')
        self.assertIsNone(response.data['capacity'])

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
            ('put', f'/api/sheets/{sheet.id}/rows/'),
        ):
            self.assertEqual(getattr(self.client, method)(url, {}, format='json').status_code, status.HTTP_404_NOT_FOUND, url)

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
        self.add_students(16, 'female', 'undergrad')  # 16 x 0.85 = 13.6 expected, about 6 a table
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

    def test_not_inviting_is_left_off_unless_they_checked_in(self):
        skipped, came = self.add_students(2, 'female', 'grad', status='not_inviting')
        self.check_in(came)
        self.assertEqual([s['id'] for s in self.plan()['students']], [came.id])

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

    def test_locked_and_checked_in_students_keep_their_table_on_regenerate(self):
        students = self.add_students(16, 'female', 'undergrad')
        for name in ('Mia', 'Ava', 'Zoe', 'Ivy'):
            self.add_mentor(name, 'female')
        self.generate()
        arrived = students[0]
        home = self.check_in(arrived)['table']['id']
        tables = self.plan()['tables']
        tables[1]['members'].append({'kind': 'student', 'id': students[1].id, 'locked': True})
        self.save_plan({'tables': tables})
        pinned_table = tables[1]['id']
        for _ in range(3):
            regenerated = {t['id']: t for t in self.generate()['tables']}
            self.assertIn(arrived.id, [m['id'] for m in regenerated[home]['members']])
            self.assertIn({'kind': 'student', 'id': students[1].id, 'locked': True}, regenerated[pinned_table]['members'])

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


class CheckInSeatingTests(SeatingBase):
    def test_check_in_fills_one_table_to_six_before_the_next_then_eight(self):
        students = self.add_students(17, 'female', 'undergrad', status='not_contacted')
        self.add_students(16, 'female', 'undergrad')
        for name in ('Mia', 'Ava', 'Zoe', 'Ivy'):
            self.add_mentor(name, 'female')
        self.generate()
        sizes = lambda: [len(t) for t in self.seated_students(self.plan())]
        for s in students[:7]:
            self.check_in(s)
        self.assertEqual(sizes(), [6, 1])
        for s in students[7:12]:
            self.check_in(s)
        self.assertEqual(sizes(), [6, 6])
        self.check_in(students[12])
        self.assertEqual(sizes(), [7, 6])
        for s in students[13:16]:
            self.check_in(s)
        self.assertEqual(sizes(), [8, 8])
        self.assertIsNotNone(self.check_in(students[16])['table'])
        self.assertEqual(sorted(sizes()), [8, 9])

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
