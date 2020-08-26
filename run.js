const chrono = require('chrono-node');
const iCal = require('ical');
const moment = require('moment-timezone');

const { CommandClient, Utils } = require('detritus-client');
const { Markup } = Utils;

const { Paginator } = require('./paginator');

const CALENDAR_URL = 'https://caldav.icloud.com/published/...';
const DISCORD_TOKEN = '';
const DISCORD_WEBHOOK = 'https://discordapp.com/api/webhooks/...';
const TIMEZONE = 'America/New_York';


moment.tz.setDefault(TIMEZONE);

const commandClient = new CommandClient(DISCORD_TOKEN, {
  prefix: '!!',
  ratelimits: [
    {duration: 10000, limit: 10, type: 'guild'},
    {duration: 1000, limit: 2, type: 'channel'},
  ],
});

commandClient.add({
  name: 'ping',
  run: async (context) => {
    const { gateway, rest } = await context.client.ping();
    return context.editOrReply(`Pong! (Gateway: ${gateway.toLocaleString()} ms) (Rest: ${rest.toLocaleString()} ms)`);
  },
});

commandClient.add({
  name: 'events for',
  default: null,
  label: 'timestamp',
  type: (value) => {
    const date = chrono.parseDate(value);
    if (date) {
      return moment(date).startOf('day').seconds(1);
    }
    return false;
  },
  onBeforeRun: (context, args) => {
    return !!args.timestamp;
  },
  onCancelRun: (context, args) => {
    if (args.timestamp === null) {
      return context.editOrReply('Provide some kind of date/timestamp, like `Friday` or `Next Monday`');
    }
    return context.editOrReply('Invalid date/timestamp');
  },
  run: async (context, args) => {
    const events = getEvents(args.timestamp);
    if (events.length) {
      const pageLimit = events.length
      const paginator = new Paginator(context, {
        pageLimit,
        onPage: (pageNumber) => {
          const event = events[pageNumber - 1];
          const embed = formatEvent(event);

          {
            const timestamp = args.timestamp.format('MMM, Do YYYY');
            if (events.length === 1) {
              embed.setFooter(`Showing 1 event for ${timestamp}`);
            } else {
              embed.setFooter(`Showing ${pageNumber}/${pageLimit} events for ${timestamp}`);
            }
          }
          return embed;
        },
      });
      return paginator.start();
    }
    return context.editOrReply(`No events for ${args.timestamp}`);
  },
});

commandClient.add({
  name: 'post',
  default: moment().startOf('day').seconds(1),
  disableDm: true,
  label: 'timestamp',
  type: (value) => {
    const date = chrono.parseDate(value);
    if (date) {
      return moment(date).startOf('day').seconds(1);
    }
    return false;
  },
  onBefore: (context) => context.member.canAdministrator,
  onCancel: (context) => context.editOrReply('only admins can run this'),
  onBeforeRun: (context, args) => {
    return !!args.timestamp;
  },
  onCancelRun: (context, args) => {
    return context.editOrReply('Invalid date/timestamp');
  },
  run: async (context, args) => {
    return postEvents(context.rest, args.timestamp);
  },
});


commandClient.on('commandRunError', console.log);


const DATE_KEYS = ['created', 'end', 'dtstamp', 'start', 'lastmodified'];

const ICAL_EVENTS = [];
(async () => {
  const cluster = await commandClient.run();

  const calendarData = iCal.parseICS(String(await cluster.rest.get(CALENDAR_URL)));
  for (let data of Object.values(calendarData)) {
    if (data.type === 'VEVENT') {
      for (let key of DATE_KEYS) {
        data[key] = new Date(data[key].toISOString().slice(0, -1) + '-04:00');
      }
      if (data.rrule) {
        for (let key of ['dtstart', 'until']) {
          data.rrule.options[key] = new Date(data.rrule.options[key].toISOString().slice(0, -1) + '-04:00');
        }
      }

      let end = data.end;
      let start = data.start;
      if (data.rrule) {
        end = data.rrule.options.until;
        start = data.rrule.options.dtstart;
      }
      ICAL_EVENTS.push({
        data,
        timestamps: {
          end: moment(end).endOf('day'),
          repeatWeekdays: (data.rrule) ? data.rrule.options.byweekday : null,
          start: moment(start).startOf('day'),
        },
      });
    }
  }

  startDayLoop(cluster);
})();


function startDayLoop(cluster) {
  const now = Date.now();
  const tomorrow = moment().add(1, 'days').startOf('day').seconds(1);

  setTimeout(() => {
    postEvents(cluster.rest, tomorrow);
    startDayLoop(cluster);
  }, tomorrow.valueOf() - now);
}


function getEvents(timestamp) {
  return ICAL_EVENTS.filter(({data, timestamps}) => {
    if (timestamp.isBetween(timestamps.start, timestamps.end)) {
      if (timestamps.repeatWeekdays) {
        const timestampDay = timestamp.day();
        return timestamps.repeatWeekdays.some((day) => timestampDay === day);
      }
      return true;
    }
    return false;
  }).sort((x, y) => parseInt(x.data.sequence) - parseInt(y.data.sequence));
}


const parts = DISCORD_WEBHOOK.split('/');
const webhookToken = parts.pop();
const webhookId = parts.pop();
  
async function postEvents(rest, timestamp) {
  if (!webhookId || !webhookToken) {
    throw new Error('Invalid webhook url given');
  }
  const embeds = getEvents(timestamp).map(formatEvent);

  const payloads = [];
  while (embeds.length) {
    payloads.push(embeds.splice(0, 10));
  }
  for (let payload of payloads) {
    await rest.executeWebhook(webhookId, webhookToken, {embeds: payload});
  }
}


function formatEvent(event) {
  const { data } = event;

  const embed = new Utils.Embed();

  embed.setAuthor(data.summary);
  embed.setColor(8684933);
  {
    const description = [];
    description.push(data.description);

    if (data.url && data.url.val) {
      description.push('');
      description.push(data.url.val);
    }

    embed.setDescription(description.join('\n'));
  }

  if (data.location) {
    embed.addField('Location', data.location);
  }

  if (data.attach) {
    embed.addField('Attachments', Markup.url(data.attach.params.FILENAME, data.attach.val));
  }

  {
    let end, start, time;
    if (data.rrule) {
      end = moment(data.rrule.options.until);
      start = moment(data.rrule.options.dtstart);
    } else {
      end = moment(data.end);
      start = moment(data.start);
    }

    const description = [];

    description.push(`${start.format('MMM, Do YYYY')} to ${end.format('MMM, Do YYYY')}`);
    {
      const timeEnd = moment(data.end);
      const timeStart = moment(data.start);
      description.push(`${timeStart.format('h:mm a z')} to ${timeEnd.format('h:mm a z')} (${timeStart.from(timeEnd, true)})`);
    }

    embed.addField('Lasts Between', description.join('\n'));
  }

  if (data.rrule) {
    const { options, timeset } = data.rrule;

    const description = [];
    if (options.byweekday) {
      const days = options.byweekday.map((weekday) => {
        return moment().day(weekday).format('dddd');
      });
      description.push(`Every ${days.join(', ')}`);
    }
    embed.addField('Repeats', description.join(' '));
  }

  return embed;
}
