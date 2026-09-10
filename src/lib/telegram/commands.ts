/** The bot's general "/" menu, per language; a coach or a student gets their own commands first and these after. */
export const BOT_COMMANDS = {
  en: [
    { command: "new", description: "Create a match: /new tomorrow 19:00 Rawai" },
    { command: "match", description: "Post the card of a match: /match CODE" },
    { command: "games", description: "Open matches near you: /games phuket" },
    { command: "score", description: "Sets after a match: /score CODE 6-3 6-4" },
    { command: "tz", description: "This chat's time zone, once: /tz phuket" },
    { command: "lang", description: "Bot language: /lang en or /lang ru" },
    { command: "feedback", description: "Tell me what should change" },
    { command: "lessons", description: "Your lessons and package with your coach (private chat)" },
    { command: "coach", description: "Your lessons book, if you coach (write to me privately)" },
    { command: "help", description: "What I do (very little, on purpose)" },
  ],
  ru: [
    { command: "new", description: "Создать матч: /new завтра 19:00 Равай" },
    { command: "match", description: "Показать карточку матча: /match КОД" },
    { command: "games", description: "Открытые матчи рядом: /games пхукет" },
    { command: "score", description: "Счёт после матча: /score КОД 6-3 6-4" },
    { command: "tz", description: "Часовой пояс чата, один раз: /tz пхукет" },
    { command: "lang", description: "Язык бота: /lang ru или /lang en" },
    { command: "feedback", description: "Что стоит изменить" },
    { command: "lessons", description: "Ваши занятия и абонемент у тренера (в личке)" },
    { command: "coach", description: "Книга занятий, если вы тренер (напишите мне в личку)" },
    { command: "help", description: "Что я умею (нарочно немного)" },
  ],
};
