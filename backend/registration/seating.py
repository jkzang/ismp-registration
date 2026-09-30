"""Discussion tables and seating at check-in, ported from ISMP Operations.

The organizers' rules: SEPARATE undergrads from grads and guys from girls, seat mentors at tables
of their own gender, and aim for 3 students per mentor (4 is fine; 5 or more only when there's no
other choice).

Nobody knows for sure who will come, so students aren't seated ahead of time. Tables are planned
from expected turnout (each sign-up weighted by how often people with that contact status show
up) and each gets a group and mentors. Check-in then seats each student at a table of their group.
"""
import math
import random
import uuid
from collections import Counter, defaultdict

from rest_framework.exceptions import ValidationError

from . import models
from .models import FEMALE, GRAD, MALE, UNDERGRAD

GENDER_ORDER, LEVEL_ORDER = [FEMALE, MALE, ''], [UNDERGRAD, GRAD, '']

IDEAL_PER_MENTOR = 3
MAX_PER_MENTOR = 4
# Bigger groups let students meet each other: plan tables for two mentors, so 6 students, up to 8.
MENTORS_PER_TABLE = 2

# Share of people with each contact status who show up (the organizers' estimates).
SHOW_UP_RATES = {
    'confirmed': 0.85,
    'awaiting_response': 0.4,
    'no_response': 0.2,
    'not_contacted': 0.0,
}


def student_of(signup):
    checked_in = signup.checked_in_at is not None
    return {
        'id': signup.id,
        'name': signup.name,
        'nickname': signup.nickname,
        'gender': signup.effective_gender,
        'level': signup.effective_level,
        'status': signup.status,
        'checked_in': checked_in,
        'chance': 1.0 if checked_in else SHOW_UP_RATES.get(signup.status, 0.0),
    }


def attendees(sheet):
    """Everyone who might sit at a table: sign-ups (except Not inviting, unless they came anyway) and the chapter's mentors."""
    students = [
        student_of(s)
        for s in sheet.signups.all()
        if not (s.status == models.ContactStatus.NOT_INVITING and s.checked_in_at is None)
    ]
    mentors = [{'id': m.id, 'name': m.name, 'gender': m.gender} for m in sheet.chapter.mentors.all()]
    return students, mentors


def _majority_levels(students):
    level_counts = defaultdict(Counter)
    for s in students:
        if s['gender'] and s['level']:
            level_counts[s['gender']][s['level']] += 1
    return {g: c.most_common(1)[0][0] for g, c in level_counts.items()}


def expected_by_group(students):
    """Expected turnout per (gender, level). Unknown level counts toward that gender's larger level;
    unknown gender isn't counted (the door asks)."""
    level_by_gender = _majority_levels(students)
    expected = defaultdict(float)
    for s in students:
        if s['gender']:
            expected[(s['gender'], s['level'] or level_by_gender.get(s['gender'], UNDERGRAD))] += s['chance']
    return expected


def _tables_wanted(expected):
    """About 6 per table, never planning past 8. A group expecting under one person gets none;
    if someone does come, check-in seats them with their gender's other level."""
    if expected < 1:
        return 0
    ideal, most = IDEAL_PER_MENTOR * MENTORS_PER_TABLE, MAX_PER_MENTOR * MENTORS_PER_TABLE
    return max(1, math.ceil(expected / most), math.floor(expected / ideal + 0.5))


def table_groups(expected, mentors):
    """The (gender, level) of each table to set up. Level '' means either level.

    Each gender gets as many tables as it has mentors at most, and its mentors are shared across
    them. A gender with no mentors still gets its tables, and the board flags them."""
    mentor_counts = Counter(m['gender'] for m in mentors if m['gender'])
    groups = []
    for gender in (FEMALE, MALE):
        wanted = {level: _tables_wanted(expected.get((gender, level), 0)) for level in (UNDERGRAD, GRAD)}
        wanted = {level: n for level, n in wanted.items() if n}
        available = mentor_counts[gender] or sum(wanted.values())
        if sum(wanted.values()) <= available:
            allocation = wanted
        elif available < len(wanted):
            allocation = {'': available}  # one table for both levels
        else:
            allocation = {level: 1 for level in wanted}
            for _ in range(available - len(wanted)):
                busiest = max(allocation, key=lambda level: (expected[(gender, level)] / allocation[level], level))
                allocation[busiest] += 1
        for level in LEVEL_ORDER:
            groups += [(gender, level)] * allocation.get(level, 0)
    return groups


def _count(table, kind):
    return sum(1 for m in table['members'] if m['kind'] == kind)


def _load(table):
    return _count(table, 'student') / max(_count(table, 'mentor'), 1)


def pick_table(tables, student):
    """Index of the table to seat a student at on check-in, or None if there's no table for their gender.

    Fills one table before starting the next: the fullest table of their group with room for 3
    per mentor, then the same up to 4, and only then the least-full one. Levels stay apart: the
    other level's tables are used only when their own level has none. Tables with a mentor come
    first. Never the other gender's table."""
    same_gender = [i for i, t in enumerate(tables) if student['gender'] and t.get('gender') == student['gender']]
    own_level = [i for i in same_gender if not student['level'] or tables[i].get('level') in ('', student['level'])]
    candidates = own_level or same_gender
    candidates = [i for i in candidates if _count(tables[i], 'mentor')] or candidates
    if not candidates:
        return None

    def fits(i, per_mentor):
        return (_count(tables[i], 'student') + 1) / max(_count(tables[i], 'mentor'), 1) <= per_mentor

    for per_mentor in (IDEAL_PER_MENTOR, MAX_PER_MENTOR):
        room = [i for i in candidates if fits(i, per_mentor)]
        if room:
            return min(room, key=lambda i: (-_load(tables[i]), i))
    return min(candidates, key=lambda i: (_load(tables[i]), i))


def group_of(students):
    """(gender, level) for a table from who's sitting there, for tables saved without a group."""
    genders = Counter(s['gender'] for s in students if s['gender'])
    levels = {s['level'] for s in students if s['level']}
    return (genders.most_common(1)[0][0] if genders else '', levels.pop() if len(levels) == 1 else '')


def _new_table(gender, level):
    return {'id': uuid.uuid4().hex[:8], 'name': '', 'gender': gender, 'level': level, 'members': []}


def generate(students, mentors, existing_tables, rng=None):
    """Plans the tables and seats the mentors.

    Students aren't seated here, except ones already checked in or locked to a table by hand,
    who keep their table."""
    rng = rng or random.Random()
    students_by_id = {s['id']: s for s in students}
    mentors_by_id = {m['id']: m for m in mentors}

    tables, placed = [], set()
    for table in existing_tables:
        kept = []
        for member in table.get('members', []):
            key = (member['kind'], member['id'])
            if member['kind'] == 'student':
                student = students_by_id.get(member['id'])
                keep = student and (member.get('locked') or student['checked_in'])
            else:
                keep = member['id'] in mentors_by_id and member.get('locked')
            if keep and key not in placed:
                kept.append({'kind': member['kind'], 'id': member['id'], 'locked': bool(member.get('locked'))})
                placed.add(key)
        if kept:
            group = (table['gender'], table['level']) if table.get('gender') else group_of(
                [students_by_id[m['id']] for m in kept if m['kind'] == 'student']
            )
            tables.append({**_new_table(*group), 'id': table['id'], 'members': kept})

    needed = table_groups(expected_by_group(students), mentors)
    for table in tables:
        if (table['gender'], table['level']) in needed:
            needed.remove((table['gender'], table['level']))
    tables += [_new_table(gender, level) for gender, level in needed]
    tables.sort(key=lambda t: (GENDER_ORDER.index(t['gender']), LEVEL_ORDER.index(t['level'])))
    for number, table in enumerate(tables, start=1):
        table['name'] = f'Table {number}'

    unplaced_mentors = [m for m in mentors if ('mentor', m['id']) not in placed]
    rng.shuffle(unplaced_mentors)
    unplaced_mentors.sort(key=lambda m: not m['gender'])
    for m in unplaced_mentors:
        candidates = [i for i, t in enumerate(tables) if not m['gender'] or t['gender'] == m['gender']]
        if not candidates:
            continue  # no table of their gender: leave them for the organizer to place
        # Every table gets one mentor before any table gets a second.
        index = min(candidates, key=lambda i: (_count(tables[i], 'mentor'), i))
        tables[index]['members'].append({'kind': 'mentor', 'id': m['id'], 'locked': False})

    for s in students:
        if s['checked_in'] and ('student', s['id']) not in placed:
            index = pick_table(tables, s)
            if index is not None:
                tables[index]['members'].append({'kind': 'student', 'id': s['id'], 'locked': False})
    return tables


def table_of(tables, kind, person_id):
    return next((t for t in tables if any(m['kind'] == kind and m['id'] == person_id for m in t['members'])), None)


def table_summary(table):
    if table is None:
        return None
    mentor_ids = [m['id'] for m in table['members'] if m['kind'] == 'mentor']
    names = dict(models.Mentor.objects.filter(id__in=mentor_ids).values_list('id', 'name'))
    return {'id': table['id'], 'name': table['name'], 'mentors': [names[i] for i in mentor_ids if i in names]}


def seat_at_check_in(signup):
    """Seats a student who just checked in and returns their table (None if there's no table for them).

    Call inside a transaction: the plan row is locked so volunteers checking people in at the
    same moment don't overwrite each other's seats."""
    plan = models.SeatingPlan.objects.select_for_update().filter(sheet_id=signup.sheet_id).first()
    if plan is None:
        return None
    existing = table_of(plan.tables, 'student', signup.id)
    if existing:
        return table_summary(existing)
    index = pick_table(plan.tables, student_of(signup))
    if index is None:
        return None
    plan.tables[index]['members'].append({'kind': 'student', 'id': signup.id, 'locked': False})
    plan.save()
    return table_summary(plan.tables[index])


def unseat_after_undo(signup):
    """Frees the seat of someone whose check-in was undone, unless an organizer locked them there."""
    plan = models.SeatingPlan.objects.select_for_update().filter(sheet_id=signup.sheet_id).first()
    if plan is None:
        return
    for table in plan.tables:
        table['members'] = [
            m for m in table['members'] if not (m['kind'] == 'student' and m['id'] == signup.id and not m.get('locked'))
        ]
    plan.save()


def keep_new_check_ins(submitted, stored, signups, seen_at):
    """Puts back seats handed out at check-in after the board was loaded (at `seen_at`).

    A board save replaces every table, and the organizer never saw those people, so a save
    mustn't drop them."""
    if seen_at is None:
        return submitted
    newcomers = {s.id for s in signups if s.checked_in_at and s.checked_in_at > seen_at}
    seated = {m['id'] for t in submitted for m in t['members'] if m['kind'] == 'student'}
    by_id = {t['id']: t for t in submitted}
    for table in stored:
        for member in table['members']:
            if member['kind'] == 'student' and member['id'] in newcomers - seated and table['id'] in by_id:
                by_id[table['id']]['members'].append(member)
    return submitted


def clean_tables(tables, students, mentors, excluded_mentor_ids):
    """Checks a board edit: known people only, nobody twice, and no excluded mentors seated."""
    student_ids = {s['id'] for s in students}
    mentor_ids = {m['id'] for m in mentors}
    seen, table_ids = set(), set()
    for table in tables:
        if table['id'] in table_ids:
            raise ValidationError('Each table needs a unique id.')
        table_ids.add(table['id'])
        for member in table['members']:
            key = (member['kind'], member['id'])
            known = student_ids if member['kind'] == 'student' else mentor_ids
            if member['id'] not in known:
                raise ValidationError('A table lists someone who is not part of this sheet.')
            if key in seen:
                raise ValidationError('Someone is seated at more than one table.')
            if member['kind'] == 'mentor' and member['id'] in excluded_mentor_ids:
                raise ValidationError('A mentor marked as not coming is still seated.')
            seen.add(key)
    if not set(excluded_mentor_ids) <= mentor_ids:
        raise ValidationError('Only mentors in this chapter can be marked as not coming.')
    return tables


def plan_payload(plan):
    students, mentors = attendees(plan.sheet)
    excluded = set(plan.excluded_mentors.values_list('id', flat=True))
    student_ids = {s['id'] for s in students}
    mentor_ids = {m['id'] for m in mentors} - excluded

    def still_here(member):
        return member['id'] in (student_ids if member['kind'] == 'student' else mentor_ids)

    # Drop people removed since the plan was saved (a row deleted from the sheet, a mentor removed).
    tables = [
        {'gender': '', 'level': '', **t, 'members': [m for m in t['members'] if still_here(m)]}
        for t in plan.tables
    ]
    expected = expected_by_group(students)
    return {
        'tables': tables,
        'excluded_mentor_ids': sorted(excluded),
        'students': students,
        'mentors': mentors,
        'expected': [
            {'gender': gender, 'level': level, 'count': round(expected[(gender, level)], 1)}
            for gender in (FEMALE, MALE) for level in (UNDERGRAD, GRAD)
        ],
        'show_up_rates': SHOW_UP_RATES,
        'updated_at': plan.updated_at,
    }
