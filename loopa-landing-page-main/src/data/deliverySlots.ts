import type { Lang } from '../lib/listingQA'

export interface DeliverySlot {
  id: string
  dateLabel: string
  timeLabel: string
}

const TIME_WINDOWS = ['08:00-11:00', '12:00-15:00', '16:00-19:00']

export function generateDeliverySlots(lang: Lang): DeliverySlot[] {
  const locale = lang === 'sv' ? 'sv-SE' : 'en-GB'
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' })
  const slots: DeliverySlot[] = []

  for (let dayOffset = 1; dayOffset <= 4; dayOffset++) {
    const date = new Date()
    date.setDate(date.getDate() + dayOffset)
    const dateLabel = formatter.format(date)
    const windowsForDay = dayOffset <= 2 ? TIME_WINDOWS : TIME_WINDOWS.slice(0, 2)
    for (const timeLabel of windowsForDay) {
      slots.push({ id: `${dayOffset}-${timeLabel}`, dateLabel, timeLabel })
    }
  }

  return slots
}
