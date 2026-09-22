/**
 * Datation des lignes de log.
 *
 * Une ligne ne porte que l'heure (`02:48:30.3211164`) : la date vient du nom du
 * dossier de session. Une session qui traverse minuit voit son heure repartir a
 * zero, il faut donc suivre le fil pour changer de jour au bon moment.
 */

const TIME = /^(\d{2}):(\d{2}):(\d{2})\.(\d+)$/;

/** Recul minimal pour conclure a un changement de jour : 12 heures. */
const WRAP_THRESHOLD_SECONDS = 12 * 3600;

/** Secondes ecoulees depuis minuit, pour comparer deux heures. */
function secondsOfDay(hours: number, minutes: number, seconds: number): number {
  return hours * 3600 + minutes * 60 + seconds;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `2026-09-19T02:48:30.321+02:00` : ISO 8601 en heure locale, avec decalage. */
function toLocalIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

export class LogClock {
  readonly #day: Date;
  #lastSeconds: number;
  #dayOffset = 0;

  /**
   * @param sessionStart date et heure de lancement de la session, tirees du nom
   *   du dossier. Son heure sert de point de depart pour detecter minuit.
   */
  constructor(sessionStart: Date) {
    this.#day = new Date(
      sessionStart.getFullYear(),
      sessionStart.getMonth(),
      sessionStart.getDate(),
    );
    this.#lastSeconds = secondsOfDay(
      sessionStart.getHours(),
      sessionStart.getMinutes(),
      sessionStart.getSeconds(),
    );
  }

  /**
   * Convertit une heure de log en horodatage ISO complet.
   * Renvoie `null` si l'heure n'a pas la forme attendue.
   */
  toIso(time: string): string | null {
    const match = TIME.exec(time);
    if (match === null) return null;

    const [hours, minutes, seconds] = match.slice(1, 4).map(Number) as [number, number, number];
    // Le log ecrit 7 decimales ; on garde la milliseconde.
    const milliseconds = Number(match[4]!.slice(0, 3).padEnd(3, '0'));

    const current = secondsOfDay(hours, minutes, seconds);

    // Un vrai passage de minuit fait reculer l'heure de presque 24 heures.
    // Un recul plus modeste vient d'une relecture : deux fichiers d'une meme
    // session peuvent se recouvrir, par exemple quand une copie archivee de
    // `Power.log` cotoie le meme fichier renomme en `Power_old.log`. Compter
    // cela comme un jour de plus redaterait toute une session.
    if (this.#lastSeconds - current > WRAP_THRESHOLD_SECONDS) this.#dayOffset += 1;
    this.#lastSeconds = current;

    const date = new Date(
      this.#day.getFullYear(),
      this.#day.getMonth(),
      this.#day.getDate() + this.#dayOffset,
      hours,
      minutes,
      seconds,
      milliseconds,
    );

    return toLocalIso(date);
  }
}
