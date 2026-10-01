"""Discussion tables and seating at check-in, ported from ISMP Operations.

The organizers' rules: SEPARATE undergrads from grads and guys from girls, seat mentors at tables
of their own gender, and keep a group's tables as even as possible as students arrive, at 3
students per mentor. A table seats 8 at most: up to 2 mentors and 6 students. Once their level's
tables are at 3 per mentor, students spill into the other level's, and then spread evenly across
the gender's tables. Nobody starts a table alone, so once those are full, check-in squeezes
students in past 6 rather than open one.

A table can also be coed within its level, ideally led by a couple (a man and a woman among the
mentors with the same last name), with at least 2 students of each gender. The plan never makes
one: the simulation does, when a table is past 3 per mentor and one of the other gender has room
(see `rebalance`), and the organizer can keep that arrangement or set a table to coed by hand.

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
from .models import FEMALE, GRAD, MALE, OTHER, UNDERGRAD

COED = 'coed'  # a table's gender only: it takes both
GENDER_ORDER, LEVEL_ORDER = [FEMALE, MALE, COED, ''], [UNDERGRAD, GRAD, '']
STUDENT_LEVELS = (UNDERGRAD, GRAD)

# Bigger groups let students meet each other: tables seat 8, two mentors and 6 students. The board
# holds to both; only check-in goes past 6 students, when every table of the group is full.
MENTORS_PER_TABLE = 2
# What a table is filled to before students spill into the other level's tables.
IDEAL_PER_MENTOR = 3
# A coed table should have at least this many students of each gender, so nobody is the only one.
COED_MIN_PER_GENDER = 2
MAX_STUDENTS_PER_TABLE = 6

# Share of people with each contact status who show up (the organizers' estimates); any other status is 0.
SHOW_UP_RATES = {
    'confirmed': 0.85,
    'awaiting_response': 0.4,
    'no_response': 0.2,
}


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
    """6 per table at most. A group expecting under one person gets none;
    if someone does come, check-in seats them with their gender's other level."""
    if expected < 1:
        return 0
    return math.ceil(expected / MAX_STUDENTS_PER_TABLE)


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
    their gender's tables: ones with a mentor first, up to 6 students. Never the other gender's
    table. If every table is full (6 students), they take an extra seat at the least-full one: a
    new table would leave them sitting alone.

    A coed table counts as a table of their gender. It holds 2 seats for each gender, and one where
    someone of their gender sits alone comes first. `genders` is the gender of each seated student
    by id, needed only when there are coed tables."""
    genders = genders or {}
    same_gender = [i for i, t in enumerate(tables) if student['gender'] and t.get('gender') in (student['gender'], COED)]
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
        seated, own = _count(tables[i], 'student'), own_gender_count(i)
        if seated >= limit:
            return False
        if own is None or own < COED_MIN_PER_GENDER:
            return True
        return seated + 1 + max(0, COED_MIN_PER_GENDER - (seated - own)) <= limit

    def emptiest(indexes):
        return min(indexes, key=lambda i: (
            own_gender_count(i) != 1, _count(tables[i], 'student'), -_count(tables[i], 'mentor'), i,
        ))

    for group in (own_level, other_level):
        below_capacity = [i for i in group if open_below(i, _capacity(tables[i]))]
        if below_capacity:
            return emptiest(below_capacity)
    with_room = [i for i in same_gender if open_below(i, MAX_STUDENTS_PER_TABLE)]
    return emptiest([i for i in with_room if _count(tables[i], 'mentor')] or with_room or same_gender)


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


def rebalance(tables, genders, mentors, fixed=frozenset()):
    """A last-minute rearrangement that makes coed tables where that evens out students per mentor.
    Changes `tables` in place and returns what it did.

    While a table is past 3 students per mentor, its extra students of one gender move to a table
    of its level for the other gender (or a coed one) that is below its own 3 per mentor. That
    table becomes coed. Tables with half of a couple are picked first. A table is only made coed if
    it ends up with at least 2 students of each gender, and nobody is left the only one of their
    gender at the table they came from. Then each couple with one half at a coed table is brought
    together there, when that leaves no table worse off.

    Mentors without a table are put to use. Before any student moves, one joins the most crowded
    table of their gender that has a free mentor's seat. After, while tables are still past 3 per
    mentor, the ones left open a new table for those tables' extra students: of their own gender,
    or, for the other gender's students, a coed one that also takes 2 students of the mentors'
    gender from a table that can spare them (a lone mentor's coed table takes 2 and 2).

    `genders` is each seated student's gender by id. Students in `fixed` (really checked in, so
    already told their table) and anyone locked stay put."""
    spouse = couples(mentors)
    mentor_gender = {m['id']: m['gender'] for m in mentors}
    spare = [m for m in mentors if m['gender'] and table_of(tables, 'mentor', m['id']) is None]
    made_coed, done = set(), Counter()

    def mentors_at(table):
        return [m for m in table['members'] if m['kind'] == 'mentor']

    def excess(table):
        return _count(table, 'student') - _capacity(table)

    def crowded():
        """Tables past 3 per mentor, the worst first."""
        return sorted((t for t in tables if excess(t) > 0), key=lambda t: -excess(t))

    def same_level(a, b):
        return not a or not b or a == b

    def movable(table, gender):
        return [
            m for m in table['members']
            if m['kind'] == 'student' and not m.get('locked') and m['id'] not in fixed and genders.get(m['id']) == gender
        ]

    def seat_spare(mentor, table):
        spare.remove(mentor)
        table['members'] = table['members'] + [{'kind': 'mentor', 'id': mentor['id'], 'locked': False}]
        done['mentors_seated'] += 1

    def take(table, members):
        table['members'] = [m for m in table['members'] if m not in members]
        done['students_moved'] += len(members)
        return members

    for table in crowded():
        while excess(table) > 0 and _has_room(table, 'mentor'):
            at_table = {m['id'] for m in mentors_at(table)}
            fitting = [m for m in spare if table['gender'] in (m['gender'], COED)]
            if not fitting:
                break
            seat_spare(min(fitting, key=lambda m: spouse.get(m['id']) not in at_table), table)

    def move_for(donor, gender):
        """(receiver, students to move) relieving `donor` of students of `gender`, or None."""
        can_go = movable(donor, gender)
        at_donor = _gender_counts(donor, genders)[gender]
        options = []
        for index, receiver in enumerate(tables):
            if receiver is donor or receiver['gender'] not in (COED, MALE if gender == FEMALE else FEMALE):
                continue
            if not same_level(donor['level'], receiver['level']):
                continue
            counts, seated = _gender_counts(receiver, genders), _count(receiver, 'student')
            # Becoming coed needs 2 of the gender already there too.
            if receiver['gender'] != COED and seated - counts[gender] < COED_MIN_PER_GENDER:
                continue
            most = min(-excess(receiver), len(can_go))
            fewest = max(1, COED_MIN_PER_GENDER - counts[gender])
            if most < fewest:
                continue
            count = max(fewest, min(excess(donor), most))
            if at_donor - count == 1:  # don't leave one behind alone
                if count < most:
                    count += 1
                elif count > fewest:
                    count -= 1
                else:
                    continue
            half_of_couple = any(m['id'] in spouse for m in mentors_at(receiver))
            options.append(((not half_of_couple, seated / _count(receiver, 'mentor'), index), receiver, can_go[-count:]))
        return min(options, key=lambda o: o[0])[1:] if options else None

    def next_move():
        # The most crowded table that can be relieved goes first.
        for donor in crowded():
            for gender in (FEMALE, MALE):
                move = move_for(donor, gender)
                if move:
                    return (donor, *move)
        return None

    def relieve():
        # Each move brings a table closer to its 3 per mentor without taking another past its own.
        while move := next_move():
            donor, receiver, movers = move
            receiver['members'] = receiver['members'] + take(donor, movers)
            receiver['gender'] = COED
            made_coed.add(receiver['id'])

    relieve()

    def new_table_for(level, gender, coed):
        """Opens a table led by spare mentors for the extra students of `gender` at crowded tables
        of `level`, if at least 2 can come. Returns whether it did."""
        leaders_gender = (MALE if gender == FEMALE else FEMALE) if coed else gender
        leaders = [m for m in spare if m['gender'] == leaders_gender]
        if not leaders:
            return False
        host, guests = None, []
        if coed:
            # 2 students of the mentors' gender come too, from the fullest table that keeps 2 of its own.
            hosts = [
                t for t in tables
                if t['gender'] in (leaders_gender, COED) and same_level(level, t['level'])
                and len(movable(t, leaders_gender)) >= COED_MIN_PER_GENDER
                and _gender_counts(t, genders)[leaders_gender] >= 2 * COED_MIN_PER_GENDER
            ]
            if not hosts:
                return False
            host = max(hosts, key=lambda t: (excess(t), _count(t, 'student')))
            guests = movable(host, leaders_gender)[-COED_MIN_PER_GENDER:]
        donors = [t for t in crowded() if t is not host and same_level(level, t['level'])]
        wanted = sum(min(excess(t), len(movable(t, gender))) for t in donors) + len(guests)
        leaders = leaders[:min(MENTORS_PER_TABLE, math.ceil(wanted / IDEAL_PER_MENTOR))]
        room = max(IDEAL_PER_MENTOR * len(leaders), 2 * COED_MIN_PER_GENDER if coed else 0) - len(guests)
        # The seats go one at a time to whichever table is then furthest past its 3 per mentor.
        taking = Counter()
        for _ in range(room):
            giving = [i for i, t in enumerate(donors) if taking[i] < min(excess(t), len(movable(t, gender)))]
            if not giving:
                break
            taking[max(giving, key=lambda i: excess(donors[i]) - taking[i])] += 1
        moves = []
        for i, count in taking.items():
            if _gender_counts(donors[i], genders)[gender] - count == 1:  # don't leave one behind alone
                count -= 1
            if count > 0:
                moves.append((donors[i], movable(donors[i], gender)[-count:]))
        if sum(len(movers) for _, movers in moves) < COED_MIN_PER_GENDER:
            return False
        table = {**_new_table(COED if coed else gender, level), 'name': f'Table {len(tables) + 1}'}
        tables.append(table)
        for leader in leaders:
            seat_spare(leader, table)
        for donor, movers in [(host, guests)] * coed + moves:
            table['members'] = table['members'] + take(donor, movers)
        if coed:
            made_coed.add(table['id'])
        done['tables_added'] += 1
        return True

    def open_table():
        # A table of the students' own gender if a mentor of it is spare, else a coed one.
        return any(
            new_table_for(donor['level'], gender, coed)
            for donor in crowded() for gender in (FEMALE, MALE) for coed in (False, True)
        )

    while spare and open_table():
        relieve()  # the table that gave 2 students to a new coed one may have room now

    def swap(table, old, other, new):
        table['members'] = [new if m is old else m for m in table['members']]
        other['members'] = [old if m is new else m for m in other['members']]

    for table in tables:
        if table['gender'] != COED:
            continue
        for mentor in mentors_at(table):
            other = table_of(tables, 'mentor', spouse.get(mentor['id']))
            if other is None:
                partner = next((m for m in spare if m['id'] == spouse.get(mentor['id'])), None)
                if partner and _has_room(table, 'mentor'):
                    seat_spare(partner, table)
                    break
                continue
            if other is table:
                continue
            partner = next(m for m in mentors_at(other) if m['id'] == spouse[mentor['id']])
            if partner.get('locked'):
                continue
            partner_gender = mentor_gender[partner['id']]
            # Whoever makes way for the partner takes the partner's old seat, if that table takes them.
            makes_way = next((
                m for m in mentors_at(table)
                if m is not mentor and not m.get('locked') and m['id'] not in spouse
                and (mentor_gender[m['id']] == partner_gender or other['gender'] == COED)
            ), None)
            if makes_way:
                swap(table, makes_way, other, partner)
                done['mentors_moved'] += 2
            elif _has_room(table, 'mentor') and _count(other, 'student') <= IDEAL_PER_MENTOR * (_count(other, 'mentor') - 1):
                other['members'] = [m for m in other['members'] if m is not partner]
                table['members'] = table['members'] + [partner]
                done['mentors_moved'] += 1
            else:
                continue
            break
    return {
        'coed_tables': len(made_coed),
        **{key: done[key] for key in ('tables_added', 'students_moved', 'mentors_seated', 'mentors_moved')},
    }


def group_of(students):
    """(gender, level) for a table from who's sitting there, for tables saved without a group."""
    genders = Counter(s['gender'] for s in students if s['gender'])
    levels = {s['level'] for s in students if s['level'] in STUDENT_LEVELS}
    return (genders.most_common(1)[0][0] if genders else '', levels.pop() if len(levels) == 1 else '')


def _new_table(gender, level):
    return {'id': uuid.uuid4().hex[:8], 'name': '', 'gender': gender, 'level': level, 'members': []}


def generate(students, mentors, existing_tables, rng=None):
    """Plans the tables and seats the mentors, at most 2 a table. Mentors left over stay unseated
    for the organizer to place.

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
        candidates = [
            i for i, t in enumerate(tables)
            if (not m['gender'] or t['gender'] in (m['gender'], COED)) and _has_room(t, 'mentor')
        ]
        if not candidates:
            continue  # no table of their gender with room: leave them for the organizer to place
        # Every table gets one mentor before any table gets a second.
        index = min(candidates, key=lambda i: (_count(tables[i], 'mentor'), i))
        tables[index]['members'].append({'kind': 'mentor', 'id': m['id'], 'locked': False})

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


def simulate(students, mentors, tables, capacity=None, attendance=None, rng=None):
    """A dry run of the day on the planned tables, to try out the seating rules. Nothing is saved.

    Each sign-up comes with the chance their contact status gives them (or `attendance` of them
    come, see `_who_comes`), in a random order, and is seated by the same rule as check-in. Someone
    with no gender on the sheet gets one at random, standing in for the door's question. Once the
    capacity is reached, later arrivals are turned away; people really checked in are already
    inside. Then the tables are rearranged into coed ones where that helps (see `rebalance`).
    Returns the tables as they'd end up, the students, with those let in marked checked in, how
    many were turned away, and what the rearrangement did."""
    rng = rng or random.Random()
    tables = [{**t, 'members': list(t['members'])} for t in tables]
    seated = {m['id'] for t in tables for m in t['members'] if m['kind'] == 'student'}
    genders = {s['id']: s['gender'] for s in students}
    arrivals = _who_comes(students, attendance, rng)
    rng.shuffle(arrivals)
    arrivals.sort(key=lambda s: not s['checked_in'])
    came, turned_away = {}, 0
    for s in arrivals:
        if capacity is not None and len(came) >= capacity and not s['checked_in']:
            turned_away += 1
            continue
        s = came[s['id']] = {**s, 'checked_in': True, 'gender': s['gender'] or rng.choice([FEMALE, MALE])}
        genders[s['id']] = s['gender']
        if s['id'] in seated:
            continue
        index = pick_table(tables, s, genders)
        if index is not None:
            tables[index]['members'].append({'kind': 'student', 'id': s['id'], 'locked': False})
    rearranged = rebalance(tables, genders, mentors, fixed={s['id'] for s in students if s['checked_in']})
    return {
        'tables': tables,
        'rearranged': rearranged,
        'students': [came.get(s['id'], s) for s in students],
        'turned_away': turned_away,
    }


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
    mustn't drop them. A table the organizer filled since then keeps the organizer's version;
    the newcomer shows as not seated."""
    if seen_at is None:
        return submitted
    newcomers = {s.id for s in signups if s.checked_in_at and s.checked_in_at > seen_at}
    seated = {m['id'] for t in submitted for m in t['members'] if m['kind'] == 'student'}
    by_id = {t['id']: t for t in submitted}
    for table in stored:
        for member in table['members']:
            if member['kind'] == 'student' and member['id'] in newcomers - seated and table['id'] in by_id:
                if _has_room(by_id[table['id']], 'student'):
                    by_id[table['id']]['members'].append(member)
    return submitted


def clean_tables(tables, students, mentors, excluded_mentor_ids, stored=()):
    """Checks a board edit: known people only, nobody twice, no excluded mentors seated, and no
    table over 2 mentors or over 6 students. A table check-in took past 6 (see `stored`) may stay
    that full, but no fuller."""
    stored_students = {t['id']: _count(t, 'student') for t in stored}
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
        'updated_at': plan.updated_at,
    }
