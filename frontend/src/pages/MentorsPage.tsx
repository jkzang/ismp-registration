import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import { Segmented } from '../components/Segmented'
import { TrashIcon } from '../components/icons'
import type { Gender, Mentor } from '../types'

const GENDER_OPTIONS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
]

export function MentorsPage() {
  const [mentors, setMentors] = useState<Mentor[] | null>(null)
  const [name, setName] = useState('')
  const [gender, setGender] = useState<Gender | ''>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.listMentors().then(setMentors).catch((err) => setError(errorMessage(err, 'Couldn’t load mentors.')))
  }, [])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !gender) return
    try {
      const mentor = await api.createMentor(name.trim(), gender)
      setMentors((current) => [...(current ?? []), mentor].sort((a, b) => a.name.localeCompare(b.name)))
      setName('')
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t add the mentor.'))
    }
  }

  async function update(mentor: Mentor, data: Partial<Omit<Mentor, 'id'>>) {
    try {
      const saved = await api.updateMentor(mentor.id, data)
      setMentors((current) => current!.map((m) => (m.id === saved.id ? saved : m)))
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t save the change.'))
    }
  }

  async function remove(mentor: Mentor) {
    if (!window.confirm(`Remove ${mentor.name} from the roster? They’ll come off every sheet’s tables.`)) return
    try {
      await api.deleteMentor(mentor.id)
      setMentors((current) => current!.filter((m) => m.id !== mentor.id))
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t remove the mentor.'))
    }
  }

  return (
    <div className="mentors">
      <h1 className="page-title">Mentors</h1>
      <p className="muted mentors-help">
        Your chapter’s roster. Every sheet’s table plan uses it, and mentors sit at tables of their own gender. Mark
        someone “Not coming” on a sheet’s tables to leave them out of that event.
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
