"""Discussion tables and seating at check-in, ported from ISMP Operations.

The organizers' rules: SEPARATE undergrads from grads and guys from girls, seat mentors at tables
of their own gender, and keep a group's tables as even as possible as students arrive, at 3
students per mentor. A table seats 8 at most: up to 2 mentors and 6 students. Once their level's
tables are at 3 per mentor, students spill into the other level's, and then spread evenly across
the gender's tables. Nobody starts a table alone, so once those are full, check-in squeezes
students in past 6 rather than open one.

A table can also be coed: led by a married couple (a man and a woman among the mentors with the
same last name) and always within one level (undergrad or grad, never both or either). It takes
whichever gender is short of room, and nobody should be the only one of their gender there. One
is made when bringing a couple together at one of their tables leaves fewer students past 3 per
mentor (see `rebalance`): by the simulation, whose arrangement the organizer can keep, and by
Re-plan, when that arrangement holds up best over many pretend days (see `best_tables`). The
organizer can also set a table to coed by hand.

Nobody knows for sure who will come, so students aren't seated ahead of time. Tables are planned
from expected turnout (each sign-up weighted by how often people with that contact status show
up), plus the walk-ins nobody expected (see `WALK_IN_RATE`), and each gets a group and mentors.
Check-in then seats each student at a table of their group.
"""
import logging
import math
import random
import uuid
from collections import Counter, defaultdict

from rest_framework.exceptions import ValidationError

from . import models
from .models import FEMALE, GRAD, MALE, OTHER, UNDERGRAD

# Re-plan tells how it picks the tables here, at INFO (see `best_tables` and SEATING_LOG_LEVEL in settings).
logger = logging.getLogger(__name__)

NO_SPACE = models.ContactStatus.NO_SPACE

COED = 'coed'  # a table's gender only: it takes both
GENDER_ORDER, LEVEL_ORDER = [FEMALE, MALE, COED, ''], [UNDERGRAD, GRAD, '']
STUDENT_LEVELS = (UNDERGRAD, GRAD)

# Bigger groups let students meet each other: tables seat 8, two mentors and 6 students. The board
# holds to both; only check-in goes past 6 students, when every table of the group is full.
MENTORS_PER_TABLE = 2
# What a table is filled to before students spill into the other level's tables.
IDEAL_PER_MENTOR = 3
MAX_STUDENTS_PER_TABLE = 6

# Share of people with each contact status who show up (the organizers' estimates); any other status is 0.
SHOW_UP_RATES = {
    'confirmed': 0.85,
    'awaiting_response': 0.4,
    'no_response': 0.2,
}
# People who come without being expected, as a share of the expected turnout (from the organizers'
# attendance data). The tables are planned and scored with them (see `generate` and `pretend_days`).
WALK_IN_RATE = 0.15

# Points for each way a seat goes wrong on a pretend day (see `score_room`): higher is worse. They
# follow the order check-in falls back in (see `pick_table`), so a later fallback costs more.
PENALTIES = {
    'no_table': 10,  # per student with no table to sit at
    'past_max': 5,  # times the square of how far a table is past 6: one table of 8 is worse than two of 7
    'alone': 4,  # per student who is the only one at their table
    'lone_gender': 3,  # per student who is the only one of their gender at a coed table
    'past_ideal': 2,  # per student past 3 per mentor, up to 6
    'other_level': 1,  # per student at a table of the other level
    'empty_table': 1,  # per table where a mentor waits and nobody comes
    'lone_mentor': 1,  # per table of students led by one mentor: two mentors with 6 beat one with 3
}
# The pretend days a plan is scored over (see `evaluate`): this many at each turnout, from this far
# below the expected turnout to this far above it.
DAYS_PER_TURNOUT = 20
TURNOUT_MARGIN = 5
# About how many of those days Re-plan rearranges the mentors for, to find arrangements to score (see `best_tables`).
DAYS_REARRANGED = 22


def student_of(signup):
    checked_in = signup.checked_in_at is not None
    not_a_student = signup.effective_level == OTHER
    return {
        'id': signup.id,
        # The row's key, so the browser can find their row to tick attendance.
        'key': signup.row_key,
        'name': signup.name,
        'nickname': signup.nickname,
        'gender': signup.effective_gender,
        'level': signup.effective_level,
        'status': signup.status,
        'checked_in': checked_in,
        'waitlisted_at': signup.waitlisted_at,
        'chance': 1.0 if checked_in else 0.0 if not_a_student else SHOW_UP_RATES.get(signup.status, 0.0),
    }


def _counted(students):
    """Sign-ups that count toward the numbers: "No space" ones are only listed, unless they check in."""
    return [s for s in students if s['checked_in'] or s['status'] != NO_SPACE]


def attendees(sheet):
    """Everyone who might sit at a table: every sign-up, whatever their status, and the chapter's mentors."""
    students = [student_of(s) for s in sheet.signups.all()]
    mentors = [{'id': m.id, 'name': m.name, 'gender': m.gender} for m in sheet.chapter.mentors.all()]
    return students, mentors


def _majority_levels(students):
    level_counts = defaultdict(Counter)
    for s in students:
        if s['gender'] and s['level'] in STUDENT_LEVELS:
            level_counts[s['gender']][s['level']] += 1
    return {g: c.most_common(1)[0][0] for g, c in level_counts.items()}


def expected_by_group(students):
    """Expected turnout per (gender, level). Unknown level (or Other, once checked in) counts toward
    that gender's larger level; unknown gender isn't counted (the door asks)."""
    level_by_gender = _majority_levels(students)
    expected = defaultdict(float)
    for s in students:
        if s['gender']:
            level = s['level'] if s['level'] in STUDENT_LEVELS else level_by_gender.get(s['gender'], UNDERGRAD)
            expected[(s['gender'], level)] += s['chance']
    return expected


def _tables_wanted(expected):
    """6 per table at most, with room for the group's share of the walk-ins. A group expecting
    under one person gets none; if someone does come, check-in seats them with their gender's
    other level."""
    if expected < 1:
        return 0
    return math.ceil(expected * (1 + WALK_IN_RATE) / MAX_STUDENTS_PER_TABLE)


def table_groups(expected, mentors):
    """The (gender, level) of each table to set up. Level '' means either level.

    Each gender gets as many tables as it has mentors at most, and its mentors are shared across
    them. A gender with no mentors still gets its tables, for the organizer to find mentors for:
    check-in seats nobody at a table without one."""
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


def _capacity(table):
    return min(MAX_STUDENTS_PER_TABLE, IDEAL_PER_MENTOR * _count(table, 'mentor'))


def _gender_counts(table, genders):
    return Counter(genders.get(m['id'], '') for m in table['members'] if m['kind'] == 'student')


def _has_room(table, kind):
    return _count(table, kind) < (MAX_STUDENTS_PER_TABLE if kind == 'student' else MENTORS_PER_TABLE)


def pick_table(tables, student, genders=None):
    """Index of the table to seat a student at on check-in, or None if there's no table for their gender.

    Keeps their level's tables as even as possible, up to 3 students per mentor each: the one with
    the fewest students, and of those the one with the most mentors. A table at its 3 per mentor
    is passed over while another of their level is below its own. Once all are there, they spill
    into the other level's tables the same way. Once those are too, they spread evenly across all
    their gender's tables, up to 6 students. Never the other gender's table, and never a table
    without a mentor. If every table is full (6 students), they take an extra seat at the
    least-full one: a new table would leave them sitting alone.

    A coed table counts as a table of their gender, but only for students of its own level: nobody
    spills into it from the other level. It's the second choice of two equally full tables, so
    it fills with whichever gender is short of room. Nobody should be the only one of their
    gender there: the first of a gender to join needs a seat left for a second, a seat is kept
    for the companion of someone sitting alone, and a table where someone of their own gender
    sits alone comes first. `genders` is the gender of each seated student by id, needed only
    when there are coed tables."""
    genders = genders or {}
    # Counted once: a plan is scored over many pretend check-ins, and each asks this of every table.
    students_at = [_count(t, 'student') for t in tables]
    mentors_at = [len(t['members']) - seated for t, seated in zip(tables, students_at)]
    # Never a table without a mentor.
    same_gender = [
        i for i, t in enumerate(tables)
        if student['gender'] and mentors_at[i] and (
            t.get('gender') == student['gender']
            or (t.get('gender') == COED and t.get('level') == student['level'] and t.get('level') in STUDENT_LEVELS)
        )
    ]
    if not same_gender:
        return None
    # Unknown or Other level: any table of their gender will do.
    own_level = [
        i for i in same_gender
        if student['level'] not in STUDENT_LEVELS or tables[i].get('level') in ('', student['level'])
    ]
    other_level = [i for i in same_gender if i not in own_level]

    def own_gender_count(i):
        return _gender_counts(tables[i], genders)[student['gender']] if tables[i].get('gender') == COED else None

    def open_below(i, limit):
        seated, own = students_at[i], own_gender_count(i)
        if own is None:
            return seated < limit
        # Their own seat, one for a second of their gender, and one for a lone other's companion.
        other = seated - own
        return seated + 1 + (own == 0 and other > 0) + (other == 1) <= limit

    def emptiest(indexes):
        return min(indexes, key=lambda i: (
            own_gender_count(i) != 1, students_at[i], tables[i].get('gender') == COED, -mentors_at[i], i,
        ))

    for group in (own_level, other_level):
        below_capacity = [i for i in group if open_below(i, min(MAX_STUDENTS_PER_TABLE, IDEAL_PER_MENTOR * mentors_at[i]))]
        if below_capacity:
            return emptiest(below_capacity)
    return emptiest([i for i in same_gender if open_below(i, MAX_STUDENTS_PER_TABLE)] or same_gender)


def couples(mentors):
    """{mentor id: their spouse's id}. A couple is a man and a woman with the same last name,
    when they're the only man and the only woman with it."""
    by_last_name = defaultdict(list)
    for m in mentors:
        words = m['name'].split()
        if len(words) > 1:
            by_last_name[words[-1].casefold()].append(m)
    spouse = {}
    for family in by_last_name.values():
        women = [m['id'] for m in family if m['gender'] == FEMALE]
        men = [m['id'] for m in family if m['gender'] == MALE]
        if len(women) == 1 and len(men) == 1:
            spouse[women[0]], spouse[men[0]] = men[0], women[0]
    return spouse


def rebalance(tables, students, mentors, fixed=frozenset()):
    """A last-minute rearrangement of the mentors that eases tables past 3 students per mentor,
    making coed tables where that helps. Changes `tables` in place and returns what it did.

    It tries changes to where the mentors sit, re-seats the students by the check-in rule (see
    `pick_table`) in the order they came, and keeps a change only if fewer students in all end up
    past 3 per mentor, with no more of them left without a table. The change that helps most goes first, until none helps. The changes:

    - A couple comes together. A coed table is led by a married couple and no one else, and is
      one level only, so a table goes coed by a mentor's spouse joining them at their undergrad or
      grad table, from another table or from having none. Any other mentor there makes way,
      moving to a table of their own gender with a free mentor's seat. A table the spouse was
      leading alone gets a mentor of its gender who had no table, or the spouse stays.
    - A mentor without a table opens a new one for their gender at a level with a crowded table,
      if at least 2 students end up there.

    After either, mentors still without a table join crowded tables of their gender that have a
    free mentor's seat.

    `students` are the ones who came, in that order. Those in `fixed` (really checked in, so
    already told their table) and anyone locked stay put, and a table where one of them is of the
    other level doesn't go coed."""
    spouse = couples(mentors)
    mentors_by_id = {m['id']: m for m in mentors}
    genders = {s['id']: s['gender'] for s in students}
    levels = {s['id']: s['level'] for s in students}
    spare = [m for m in mentors if m['gender'] and table_of(tables, 'mentor', m['id']) is None]
    done = Counter()
    planned, was_coed = len(tables), {t['id'] for t in tables if t['gender'] == COED}

    def staying(member):
        return member['kind'] == 'mentor' or member.get('locked') or member['id'] in fixed

    def seats():
        return {m['id']: t['id'] for t in tables for m in t['members'] if m['kind'] == 'student'}

    seats_before = seats()
    stay_put = {m['id'] for t in tables for m in t['members'] if m['kind'] == 'student' and staying(m)}

    def mentors_at(table):
        return [m for m in table['members'] if m['kind'] == 'mentor']

    def led_by_couple(table):
        ids = [m['id'] for m in mentors_at(table)]
        return len(ids) == 2 and spouse.get(ids[0]) == ids[1]

    def excess(table):
        return _count(table, 'student') - _capacity(table)

    def crowded():
        """Tables past 3 per mentor, the worst first."""
        return sorted((t for t in tables if excess(t) > 0), key=lambda t: -excess(t))

    def reseat():
        for table in tables:
            table['members'] = [m for m in table['members'] if staying(m)]
        for student in students:
            index = None if student['id'] in stay_put else pick_table(tables, student, genders)
            if index is not None:
                tables[index]['members'] = tables[index]['members'] + [{'kind': 'student', 'id': student['id'], 'locked': False}]

    def seat(mentor, table):
        table['members'] = table['members'] + [{'kind': 'mentor', 'id': mentor['id'], 'locked': False}]

    def seat_spare(mentor, table):
        spare.remove(mentor)
        seat(mentor, table)
        done['mentors_seated'] += 1

    def settle():
        """Re-seats the students, giving crowded tables a mentor who has none while that's possible."""
        while True:
            reseat()
            joining = next((
                (m, t) for t in crowded() if _has_room(t, 'mentor') for m in spare if m['gender'] == t['gender']
            ), None)
            if joining is None:
                return
            seat_spare(*joining)

    def unite(table, stays):
        """Brings the spouse of `stays` (a mentor at `table`) to lead it with them, making it coed.
        Returns whether it could."""
        partner = mentors_by_id[spouse[stays['id']]]
        other_level = any(
            m['kind'] == 'student' and staying(m) and levels.get(m['id']) in STUDENT_LEVELS and levels[m['id']] != table['level']
            for m in table['members']
        )
        if table['gender'] not in (mentors_by_id[stays['id']]['gender'], COED) or table['level'] not in STUDENT_LEVELS or other_level:
            return False
        make_way = [m for m in mentors_at(table) if m is not stays]
        old = table_of(tables, 'mentor', partner['id'])
        seated = old and next(m for m in mentors_at(old) if m['id'] == partner['id'])
        # A table the spouse leads alone needs someone to take over.
        alone = old and _count(old, 'mentor') == 1
        takes_over = next((m for m in spare if m['gender'] == old['gender']), None) if alone else None
        if any(m.get('locked') for m in make_way) or (old and seated.get('locked')) or (alone and takes_over is None):
            return False
        table['members'] = [m for m in table['members'] if m not in make_way]
        if old:
            old['members'] = [m for m in old['members'] if m is not seated]
            seat(partner, table)
            done['mentors_moved'] += 1
            if takes_over:
                seat_spare(takes_over, old)
        else:
            seat_spare(partner, table)
        table['gender'] = COED
        for member in make_way:
            mentor = mentors_by_id[member['id']]
            homes = [t for t in tables if t['gender'] == mentor['gender'] and _has_room(t, 'mentor')]
            if homes:
                # Mentorless tables first, then the most students per mentor.
                home = max(homes, key=lambda t: (not _count(t, 'mentor'), _count(t, 'student') / max(_count(t, 'mentor'), 1)))
                home['members'] = home['members'] + [member]
            else:
                spare.append(mentor)
            done['mentors_moved'] += 1
        return True

    def open_table(gender, level):
        table = {**_new_table(gender, level), 'name': f'Table {len(tables) + 1}'}
        tables.append(table)
        seat_spare(next(m for m in spare if m['gender'] == gender), table)
        return True

    def changes():
        for table in tables:
            for stays in mentors_at(table):
                if stays['id'] in spouse and not led_by_couple(table):
                    yield lambda table=table, stays=stays: unite(table, stays)
        for gender, level in sorted({(t['gender'], t['level']) for t in crowded()}):
            if any(m['gender'] == gender for m in spare):
                yield lambda gender=gender, level=level: open_table(gender, level)

    def score():
        """Students left without a table, students past 3 per mentor, students who are the only
        one of their gender at a coed table, then mentors moved. None if a new table would seat
        fewer than 2."""
        if any(_count(t, 'student') < 2 for t in tables[planned:]):
            return None
        alone = sum(list(_gender_counts(t, genders).values()).count(1) for t in tables if t['gender'] == COED)
        return (
            len(students) - len(seats()), sum(max(0, excess(t)) for t in tables),
            alone, done['mentors_moved'] + done['mentors_seated'],
        )

    # Every change swaps in a new members list, so putting the old lists back undoes a trial.
    def snapshot():
        return [(t, t['gender'], t['members']) for t in tables], list(spare), Counter(done)

    def restore(saved):
        nonlocal done
        was, spare[:], done = saved
        del tables[len(was):]
        for table, gender, members in was:
            table['gender'], table['members'] = gender, members

    settle()
    while True:
        now, best = score(), None
        for change in list(changes()):
            saved = snapshot()
            if change():
                settle()
                after = score()
                if after and after[:2] < now[:2] and (best is None or after < best[0]):
                    best = (after, change)
            restore(saved)
        if best is None:
            break
        best[1]()
        settle()
    seats_after = seats()
    return {
        'coed_tables': sum(t['gender'] == COED and t['id'] not in was_coed for t in tables),
        'tables_added': len(tables) - planned,
        'students_moved': sum(seats_after.get(i) != seat for i, seat in seats_before.items()),
        'mentors_seated': done['mentors_seated'],
        'mentors_moved': done['mentors_moved'],
    }


def group_of(students):
    """(gender, level) for a table from who's sitting there, for tables saved without a group."""
    genders = Counter(s['gender'] for s in students if s['gender'])
    levels = {s['level'] for s in students if s['level'] in STUDENT_LEVELS}
    return (genders.most_common(1)[0][0] if genders else '', levels.pop() if len(levels) == 1 else '')


def _new_table(gender, level):
    return {'id': uuid.uuid4().hex[:8], 'name': '', 'gender': gender, 'level': level, 'members': []}


def _in_order(tables):
    """Sorts the tables by group and numbers them."""
    tables.sort(key=lambda t: (GENDER_ORDER.index(t['gender']), LEVEL_ORDER.index(t['level'])))
    for number, table in enumerate(tables, start=1):
        table['name'] = f'Table {number}'
    return tables


def _seat_mentors(tables, mentors, expected):
    """Seats mentors who have no table, in the order given but those with no gender last. Every
    table gets one mentor before any gets a second, and second mentors go first to the groups
    expecting the most students a table. A mentor with no table of their gender with room is
    left for the organizer to place."""
    sharing = Counter((t['gender'], t['level']) for t in tables)

    def load(table):
        genders = (FEMALE, MALE) if table['gender'] in (COED, '') else (table['gender'],)
        levels = (table['level'],) if table['level'] in STUDENT_LEVELS else STUDENT_LEVELS
        return sum(expected.get((g, l), 0) for g in genders for l in levels) / sharing[(table['gender'], table['level'])]

    for m in sorted(mentors, key=lambda m: not m['gender']):
        candidates = [
            i for i, t in enumerate(tables)
            if (not m['gender'] or t['gender'] in (m['gender'], COED)) and _has_room(t, 'mentor')
        ]
        if candidates:
            index = min(candidates, key=lambda i: (_count(tables[i], 'mentor'), -load(tables[i]), i))
            tables[index]['members'] = tables[index]['members'] + [{'kind': 'mentor', 'id': m['id'], 'locked': False}]


def generate(students, mentors, existing_tables, rng=None):
    """Plans the tables and seats the mentors, at most 2 a table (see `_seat_mentors`). Mentors
    left over stay unseated for the organizer to place.

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
    _in_order(tables)

    unplaced_mentors = [m for m in mentors if ('mentor', m['id']) not in placed]
    rng.shuffle(unplaced_mentors)
    _seat_mentors(tables, unplaced_mentors, expected_by_group(students))

    genders = {s['id']: s['gender'] for s in students}
    for s in students:
        if s['checked_in'] and ('student', s['id']) not in placed:
            index = pick_table(tables, s, genders)
            if index is not None:
                tables[index]['members'].append({'kind': 'student', 'id': s['id'], 'locked': False})
    return tables


def _who_comes(students, attendance, rng):
    """Who turns up. With no `attendance`, each sign-up comes with the chance their contact status
    gives them. With one, exactly that many come (or everyone, if it's more than signed up):
    those checked in, then the rest drawn one by one, likelier ones more often."""
    students = _counted(students)
    if attendance is None:
        return [s for s in students if s['checked_in'] or rng.random() < s['chance']]
    arrivals = [s for s in students if s['checked_in']]
    waiting = [s for s in students if not s['checked_in']]
    while waiting and len(arrivals) < attendance:
        weights = [s['chance'] for s in waiting]
        # Out of people with any chance of coming: the rest are equally unlikely.
        pick = rng.choices(range(len(waiting)), weights if any(weights) else None)[0]
        arrivals.append(waiting.pop(pick))
    return arrivals


def _walk_ins(students, count, rng):
    """Stand-ins for `count` people who come without being expected. Their gender and level
    follow the expected turnout's mix, and their ids are negative, so they're never a sign-up's."""
    expected = {group: n for group, n in expected_by_group(students).items() if n > 0}
    if not count or not expected:
        return []
    groups = rng.choices(list(expected), list(expected.values()), k=count)
    return [
        {
            'id': -number, 'key': '', 'name': f'Walk-in {number}', 'nickname': '', 'gender': gender, 'level': level,
            'status': models.ContactStatus.NOT_CONTACTED, 'checked_in': False, 'waitlisted_at': None, 'chance': 1.0,
        }
        for number, (gender, level) in enumerate(groups, start=1)
    ]


def _likely(students):
    """The expected turnout, to the nearest person."""
    return round(sum(s['chance'] for s in students))


def _walk_ins_expected(students):
    return round(WALK_IN_RATE * _likely(students))


def _who_gets_in(students, capacity, attendance, rng, walk_ins=0):
    """One pretend day at the door: those let in, in the order they came, and how many were turned away.

    Each sign-up comes with the chance their contact status gives them (or `attendance` of them
    come, see `_who_comes`), and `walk_ins` more people come unexpected (see `_walk_ins`), all in
    a random order. Someone with no gender on the sheet gets one at random, standing in for the
    door's question. Once the capacity is reached, later arrivals are turned away; people really
    checked in are already inside."""
    arrivals = _who_comes(students, attendance, rng) + _walk_ins(students, walk_ins, rng)
    rng.shuffle(arrivals)
    arrivals.sort(key=lambda s: not s['checked_in'])
    came, turned_away = [], 0
    for s in arrivals:
        if capacity is not None and len(came) >= capacity and not s['checked_in']:
            turned_away += 1
        else:
            came.append({**s, 'checked_in': True, 'gender': s['gender'] or rng.choice([FEMALE, MALE])})
    return came, turned_away


def _seat(tables, came, students):
    """A copy of the tables with those who came seated by the same rule as check-in, in the order they came."""
    tables = [{**t, 'members': list(t['members'])} for t in tables]
    seated = {m['id'] for t in tables for m in t['members'] if m['kind'] == 'student'}
    genders = {}
    if any(t.get('gender') == COED for t in tables):
        genders = {**{s['id']: s['gender'] for s in students}, **{s['id']: s['gender'] for s in came}}
    for s in came:
        if s['id'] not in seated:
            index = pick_table(tables, s, genders)
            if index is not None:
                tables[index]['members'].append({'kind': 'student', 'id': s['id'], 'locked': False})
    return tables


def simulate(students, mentors, tables, capacity=None, attendance=None, rng=None):
    """A dry run of the day on the planned tables, to try out the seating rules. Nothing is saved.

    Runs one pretend day (see `_who_gets_in`), with the walk-ins the expected turnout brings (see
    `WALK_IN_RATE`) on top of the sign-ups who come, and seats those let in by the check-in rule,
    then rearranges the tables into coed ones where that helps (see `rebalance`). Returns the
    tables as they'd end up, the students, with those let in marked checked in, the walk-ins let
    in, how many were turned away, and what the rearrangement did."""
    came, turned_away = _who_gets_in(students, capacity, attendance, rng or random.Random(), _walk_ins_expected(students))
    tables = _seat(tables, came, students)
    rearranged = rebalance(tables, came, mentors, fixed={s['id'] for s in students if s['checked_in']})
    came_by_id = {s['id']: s for s in came}
    return {
        'tables': tables,
        'rearranged': rearranged,
        'students': [came_by_id.get(s['id'], s) for s in students],
        'walk_ins': [s for s in came if s['id'] < 0],
        'turned_away': turned_away,
    }


def score_room(tables, came):
    """Penalty points for how a day ended up, by cause (see `PENALTIES`). `came` are the students
    let in. All zeros is a day where everyone sits at a table of their own level, within 3 per
    mentor, with company, at tables led by two mentors, and no mentor waits at an empty table."""
    came_by_id = {s['id']: s for s in came}
    counts = dict.fromkeys(PENALTIES, 0)
    seated = 0
    for table in tables:
        students = [came_by_id[m['id']] for m in table['members'] if m['kind'] == 'student' and m['id'] in came_by_id]
        seated += len(students)
        if not students:
            counts['empty_table'] += bool(_count(table, 'mentor'))
            continue
        counts['past_max'] += max(0, len(students) - MAX_STUDENTS_PER_TABLE) ** 2
        counts['past_ideal'] += max(0, min(len(students), MAX_STUDENTS_PER_TABLE) - _capacity(table))
        counts['lone_mentor'] += _count(table, 'mentor') == 1
        if len(students) == 1:
            counts['alone'] += 1
        elif table.get('gender') == COED:
            counts['lone_gender'] += list(Counter(s['gender'] for s in students).values()).count(1)
        levels = Counter(s['level'] for s in students if s['level'] in STUDENT_LEVELS)
        if table.get('level') in STUDENT_LEVELS:
            counts['other_level'] += sum(levels.values()) - levels[table['level']]
        else:
            # A table for either level: the fewer of the two are the ones sitting with the other level.
            counts['other_level'] += min(levels[UNDERGRAD], levels[GRAD])
    counts['no_table'] = len(came) - seated
    return {cause: PENALTIES[cause] * count for cause, count in counts.items()}


def pretend_days(students, capacity=None, rng=None):
    """Who gets in on each of the pretend days a plan is scored over (see `_who_gets_in`): every
    turnout within `TURNOUT_MARGIN` of the expected one, `DAYS_PER_TURNOUT` of each, and on every
    day the walk-ins that expected turnout brings (see `WALK_IN_RATE`)."""
    rng = rng or random.Random()
    likely, walk_ins = _likely(students), _walk_ins_expected(students)
    turnouts = range(max(0, likely - TURNOUT_MARGIN), min(len(_counted(students)), likely + TURNOUT_MARGIN) + 1)
    return [_who_gets_in(students, capacity, n, rng, walk_ins)[0] for n in turnouts for _ in range(DAYS_PER_TURNOUT)]


def _day_scores(tables, students, days):
    """The points each pretend day ends with, by cause: the day's students are seated by the
    check-in rule alone (see `_seat`) and the room is scored (see `score_room`)."""
    return [score_room(_seat(tables, came, students), came) for came in days]


def _worst(totals):
    """The worst tenth of the days' points."""
    return sorted(totals)[-max(1, len(totals) // 10):]


def evaluate(tables, students, days):
    """How the tables would hold up on the day, over the pretend days (see `pretend_days`).
    Nothing is saved. Returns the average points a day, the average over the worst tenth of the
    days, and the average points a day from each cause. Lower is better."""
    scores = _day_scores(tables, students, days)
    totals = [sum(day.values()) for day in scores]
    worst = _worst(totals)
    return {
        'days': len(days),
        'turnout': [min(map(len, days)), max(map(len, days))],
        'average': round(sum(totals) / len(totals), 1),
        'worst': round(sum(worst) / len(worst), 1),
        'causes': {cause: round(sum(day[cause] for day in scores) / len(scores), 1) for cause in PENALTIES},
    }


def _group_name(gender, level):
    return f'{gender or "any gender"} {level or "either level"}'


def _outline(tables):
    """The tables in one line, for the log: each group's tables, by how many mentors lead each."""
    leaders = defaultdict(list)
    for table in tables:
        leaders[(table['gender'], table['level'])].append(str(_count(table, 'mentor')))
    return f'{len(tables)} tables: ' + ', '.join(f'{_group_name(*group)} {"+".join(n)}' for group, n in leaders.items())


def best_tables(students, mentors, existing_tables, days, rng=None):
    """The tables for Re-plan: of the arrangements the pretend days call for, the one that holds
    up best over all of them (see `evaluate`).

    It starts from the tables as first planned (see `generate`). For each pretend day, that
    day's students are seated by the check-in rule and the mentors are rearranged for them (see
    `rebalance`): once from the plan as it is, and once with one mentor a table, so the rest go
    where that day's crowds are. That can make coed tables and open new ones. Each arrangement
    is then scored over every day, without the rearranging, since check-in doesn't move mentors.
    The lowest average wins; a tie goes to the better worst days, then to the fewest tables,
    then to the arrangement found first, so to the plan as first planned.

    The winner is then tried with a table closed, and with two of a gender's tables, one of each
    level, merged into one for both, for as long as either scores better. Their mentors go to
    the tables with room. Tables with someone locked or already seated, or with no mentor yet,
    are left as they are, and so is any table whose closing would leave more students without one.

    Each step is logged: the arrangements found and where each came from, their scores, and
    what closing or merging tables did."""
    draft = generate(students, mentors, existing_tables, rng)
    kept = {m['id'] for t in draft for m in t['members'] if m['kind'] == 'student'}
    fixed = {s['id'] for s in students if s['checked_in']}
    genders = {m['id']: m['gender'] for m in mentors}
    expected = expected_by_group(students)
    # The log's lines are only put together when someone is reading them.
    logging_on = logger.isEnabledFor(logging.INFO)
    if logging_on:
        by_group = ', '.join(f'{_group_name(*group)} {n:.1f}' for group, n in sorted(expected.items()) if n)
        by_gender = Counter(m['gender'] or 'no gender' for m in mentors)
        logger.info(
            'Table plan: %d sign-ups, %.1f expected (%s); %d mentors (%s)',
            len(_counted(students)), sum(expected.values()), by_group or 'nobody',
            len(mentors), ', '.join(f'{n} {gender}' for gender, n in sorted(by_gender.items())) or 'none',
        )
        logger.info(
            '  scored over %d pretend days of %d to %d students; lower is better. Weights: %s',
            len(days), min(map(len, days), default=0), max(map(len, days), default=0),
            ', '.join(f'{cause} {weight}' for cause, weight in PENALTIES.items()),
        )

    def one_mentor_each(tables):
        """Takes each table's second mentor away, unless they're locked there or have no gender to seat them by."""
        thinned = []
        for table in tables:
            leaders = [m for m in table['members'] if m['kind'] == 'mentor']
            leaving = [m for m in leaders if not m.get('locked') and genders[m['id']]][:max(0, len(leaders) - 1)]
            thinned.append({**table, 'members': [m for m in table['members'] if m not in leaving]})
        return thinned

    def arrangement(tables):
        """The tables a day ended with, without that day's students, and with any mentor still spare seated."""
        tables = [
            {**t, 'members': [m for m in t['members'] if m['kind'] == 'mentor' or m['id'] in kept]} for t in tables
        ]
        _seat_mentors(tables, [m for m in mentors if table_of(tables, 'mentor', m['id']) is None], expected)
        return _in_order(tables)

    def shape(tables):
        """What the score depends on. Mentors only count by how many lead a table."""
        return tuple(sorted(
            (
                GENDER_ORDER.index(t['gender']), LEVEL_ORDER.index(t['level']), _count(t, 'mentor'),
                tuple(sorted(m['id'] for m in t['members'] if m['kind'] == 'student')),
            )
            for t in tables
        ))

    starts = [draft]
    if shape(one_mentor_each(draft)) != shape(draft):
        starts.append(one_mentor_each(draft))
    found = {shape(draft): draft}
    # Where each arrangement was first found, for the log.
    source = {shape(draft): 'the first plan'}
    step = max(1, len(days) // DAYS_REARRANGED)
    for number, came in list(enumerate(days, start=1))[::step]:
        for start in starts:
            tables = _seat(start, came, students)
            did = rebalance(tables, came, mentors, fixed)
            tables = arrangement(tables)
            if shape(tables) not in found:
                found[shape(tables)] = tables
                changes = ', '.join(f'{what.replace("_", " ")} {n}' for what, n in did.items() if n and what != 'students_moved')
                source[shape(tables)] = (
                    f'day {number}, {len(came)} came, from {"the first plan" if start is draft else "one mentor a table"}'
                    f': {changes or "mentors seated differently"}'
                )

    scored, causes = {}, {}

    def points(tables):
        if shape(tables) not in scored:
            day_scores = _day_scores(tables, students, days)
            totals = [sum(day.values()) for day in day_scores]
            scored[shape(tables)] = sum(totals), sum(_worst(totals)), len(tables)
            causes[shape(tables)] = {cause: sum(day[cause] for day in day_scores) for cause in PENALTIES}
        return scored[shape(tables)]

    def score_line(tables):
        """The score as the log shows it: points a day, on the worst tenth of the days, and from each cause."""
        total, worst, _ = points(tables)
        a_day = {cause: n / len(days) for cause, n in causes[shape(tables)].items() if n}
        return '%.2f a day, %.1f on the worst days (%s)' % (
            total / len(days), worst / max(1, len(days) // 10),
            ', '.join(f'{cause} {n:.2f}' for cause, n in a_day.items()) or 'nothing went wrong',
        )

    def fewer_tables(tables):
        """What was done and the arrangement it gives: one table closed, or two merged into one for both levels."""
        # A table without a mentor stays: it's there for the organizer to find one for.
        free = [
            t for t in tables
            if t['members'] and not any(m['kind'] == 'student' or m.get('locked') for m in t['members'])
        ]
        # Tables alike in group and mentors are interchangeable: closing one of each kind is enough.
        for (gender, level, leading), table in {(t['gender'], t['level'], _count(t, 'mentor')): t for t in free}.items():
            what = f'close a {leading}-mentor {_group_name(gender, level)} table'
            yield what, arrangement([t for t in tables if t is not table])
        for gender in (FEMALE, MALE):
            pair = [next((t for t in free if (t['gender'], t['level']) == (gender, level)), None) for level in STUDENT_LEVELS]
            if all(pair):
                both = {**pair[0], 'level': '', 'members': (pair[0]['members'] + pair[1]['members'])[:MENTORS_PER_TABLE]}
                what = f'merge a {gender} undergrad table and a {gender} grad table'
                yield what, arrangement([both if t is pair[0] else t for t in tables if t is not pair[1]])

    best = min(found.values(), key=points)
    if logging_on and days:
        logger.info(
            '  rearranged the mentors for %d of those days, from %d starting points: %d arrangements'
            ' (the numbers are the mentors at each table)', len(days[::step]), len(starts), len(found),
        )
        for place, tables in enumerate(sorted(found.values(), key=points), start=1):
            logger.info('  #%d  %s', place, score_line(tables))
            logger.info('      %s', _outline(tables))
            logger.info('      found: %s', source[shape(tables)])
        logger.info('  #1 scores lowest. Ties go to the better worst days, then the fewest tables, then the one found first.')
    def unseated(tables):
        points(tables)
        return causes[shape(tables)]['no_table']

    while True:
        # Never at the cost of a seat: a very full table would otherwise score worse than no table at all.
        options = [option for option in fewer_tables(best) if unseated(option[1]) <= unseated(best)]
        _, smaller = min(options, key=lambda option: points(option[1]), default=('', best))
        if logging_on and days and options:
            logger.info('  with a table fewer than %s:', _outline(best))
            for what, tables in options:
                better = points(tables) < points(best)
                verdict = 'no better' if not better else 'better, kept' if tables is smaller else 'better, but not the lowest'
                logger.info('    %s: %s -> %s', what, score_line(tables), verdict)
        if points(smaller) >= points(best):
            break
        best = smaller
    if logging_on and days:
        logger.info('  chosen: %s', score_line(best))
        logger.info('      %s', _outline(best))
    return best


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
    same moment don't overwrite each other's seats. May add a table when their group's are full."""
    plan = models.SeatingPlan.objects.select_for_update().filter(sheet_id=signup.sheet_id).first()
    if plan is None:
        return None
    existing = table_of(plan.tables, 'student', signup.id)
    if existing:
        return table_summary(existing)
    genders = {}
    if any(t.get('gender') == COED for t in plan.tables):
        seated = [m['id'] for t in plan.tables for m in t['members'] if m['kind'] == 'student']
        genders = {s.id: s.effective_gender for s in models.Signup.objects.filter(id__in=seated)}
    index = pick_table(plan.tables, student_of(signup), genders)
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
    mustn't drop them. A table the organizer filled since then, or took the mentors from, keeps
    the organizer's version; the newcomer shows as not seated."""
    if seen_at is None:
        return submitted
    newcomers = {s.id for s in signups if s.checked_in_at and s.checked_in_at > seen_at}
    seated = {m['id'] for t in submitted for m in t['members'] if m['kind'] == 'student'}
    by_id = {t['id']: t for t in submitted}
    for table in stored:
        for member in table['members']:
            if member['kind'] == 'student' and member['id'] in newcomers - seated and table['id'] in by_id:
                if _has_room(by_id[table['id']], 'student') and _count(by_id[table['id']], 'mentor'):
                    by_id[table['id']]['members'].append(member)
    return submitted


def clean_tables(tables, students, mentors, excluded_mentor_ids, stored=()):
    """Checks a board edit: known people only, nobody twice, no excluded mentors seated, no
    students at a table without a mentor, no guys with girls of the other level, and no table over 2
    mentors or over 6 students. A table check-in took past 6 (see `stored`) may stay that full,
    but no fuller."""
    stored_students = {t['id']: _count(t, 'student') for t in stored}
    groups = {s['id']: (s['gender'], s['level']) for s in students}
    student_ids = {s['id'] for s in students}
    mentor_ids = {m['id'] for m in mentors}
    seen, table_ids = set(), set()
    for table in tables:
        if table['id'] in table_ids:
            raise ValidationError('Each table needs a unique id.')
        table_ids.add(table['id'])
        most_students = max(MAX_STUDENTS_PER_TABLE, stored_students.get(table['id'], 0))
        if _count(table, 'student') > most_students or _count(table, 'mentor') > MENTORS_PER_TABLE:
            raise ValidationError(
                f'A table can have at most {MAX_STUDENTS_PER_TABLE} students and {MENTORS_PER_TABLE} mentors.'
            )
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
        name = table.get('name') or 'A table'
        if _count(table, 'student') and not _count(table, 'mentor'):
            raise ValidationError(f'{name} has students but no mentor. Seat a mentor there first, or move the students.')
        seated = {groups[m['id']] for m in table['members'] if m['kind'] == 'student'}
        for guys, girls in ((GRAD, UNDERGRAD), (UNDERGRAD, GRAD)):
            if {(MALE, guys), (FEMALE, girls)} <= seated:
                raise ValidationError(f'{name} would seat {guys} guys with {girls} girls.')
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
            {
                'gender': gender, 'level': level, 'count': round(expected[(gender, level)], 1),
                # Before the cap of one table per mentor; the first-plan explanation compares the two.
                'tables_wanted': _tables_wanted(expected[(gender, level)]),
            }
            for gender in (FEMALE, MALE) for level in (UNDERGRAD, GRAD)
        ],
        'show_up_rates': SHOW_UP_RATES,
        # For the Sign-ups page's overview, which estimates turnout the same way.
        'walk_in_rate': WALK_IN_RATE,
        'ideal_per_mentor': IDEAL_PER_MENTOR,
        'updated_at': plan.updated_at,
    }
