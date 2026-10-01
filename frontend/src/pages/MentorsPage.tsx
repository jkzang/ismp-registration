import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Segmented } from '../components/Segmented'
import { TrashIcon } from '../components/icons'
import type { Gender, Mentor } from '../types'
import { useUndo } from '../undo'

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
]

export function MentorsPage() {
  const [mentors, setMentors] = useState<Mentor[] | null>(null)
  const [name, setName] = useState('')
  const [gender, setGender] = useState<Gender | ''>('')
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Mentor | null>(null)
  const { push } = useUndo()

  const sorted = (list: Mentor[]) => list.sort((a, b) => a.name.localeCompare(b.name))

  async function create(name: string, gender: Gender) {
    const mentor = await api.createMentor(name, gender)
    setMentors((current) => sorted([...(current ?? []), mentor]))
    return mentor
  }

  async function destroy(mentor: Mentor) {
    await api.deleteMentor(mentor.id)
    setMentors((current) => current!.filter((m) => m.id !== mentor.id))
  }

  async function patch(id: number, data: Partial<Omit<Mentor, 'id'>>) {
    const saved = await api.updateMentor(id, data)
    setMentors((current) => current!.map((m) => (m.id === saved.id ? saved : m)))
  }

  useEffect(() => {
    api.listMentors().then(setMentors).catch((err) => setError(errorMessage(err, 'Couldn’t load mentors.')))
  }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !gender) return
    try {
      // Redo re-creates them under a new id, which a later undo has to delete.
      let mentor = await create(name.trim(), gender)
      push({
        label: `adding ${mentor.name}`,
        undo: () => destroy(mentor),
        redo: async () => (mentor = await create(mentor.name, mentor.gender)),
      })
      setName('')
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t add the mentor.'))
    }
  }

  async function update(mentor: Mentor, data: Partial<Omit<Mentor, 'id'>>) {
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, mentor[k as keyof typeof data]]))
    try {
      await patch(mentor.id, data)
      push({ label: `the change to ${mentor.name}`, undo: () => patch(mentor.id, before), redo: () => patch(mentor.id, data) })
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t save the change.'))
    }
  }

  async function remove(removed: Mentor) {
    setRemoving(null)
    let mentor = removed
    try {
      await destroy(mentor)
      // Undo brings them back as a new roster entry (not re-seated), which redo then removes.
      push({
        label: `removing ${mentor.name}`,
        undo: async () => (mentor = await create(mentor.name, mentor.gender)),
        redo: () => destroy(mentor),
      })
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t remove the mentor.'))
    }
  }

  return (
    <div className="mentors">
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'mentor'} from the roster?`}
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && remove(removing)}
        onClose={() => setRemoving(null)}
      >
        They’ll come off every sheet’s tables.
      </ConfirmDialog>
      <h1 className="page-title">Mentors</h1>
      <p className="muted mentors-help">
        Your chapter’s roster. Every sheet’s table plan uses it, and mentors sit at tables of their own gender. Mark
        someone “Absent” on a sheet’s tables to leave them out of that event.
      </p>
      <form className="mentor-add" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mentor name" aria-label="Mentor name" maxLength={120} />
        <Segmented label="Gender" value={gender} options={GENDER_OPTIONS} onChange={setGender} />
        <button type="submit" className="primary" disabled={!name.trim() || !gender}>
          Add mentor
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {mentors === null ? (
        <p className="muted">Loading…</p>
      ) : mentors.length === 0 ? (
        <p className="empty-state is-compact">No mentors yet. Add the people who lead tables.</p>
      ) : (
        <ul className="mentor-list">
          {mentors.map((m) => (
            <li key={m.id}>
              <input
                className="mentor-name"
                defaultValue={m.name}
                aria-label={`Name of ${m.name}`}
                maxLength={120}
                onBlur={(e) => {
                  const value = e.target.value.trim()
                  if (value && value !== m.name) update(m, { name: value })
                  else e.target.value = m.name
                }}
              />
              <Segmented label={`Gender of ${m.name}`} value={m.gender} options={GENDER_OPTIONS} onChange={(g) => update(m, { gender: g })} />
              <button type="button" className="chip-icon" aria-label={`Remove ${m.name}`} title="Remove" onClick={() => remove(m)}>
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
