import Imap from 'imap';
import m from 'moment';
import get from 'lodash/get';
import find from 'lodash/find';
import set from 'lodash/set';
import forEach from 'lodash/forEach';
import merge from 'lodash/merge';
import { MailParser } from 'mailparser';
import Promise from 'bluebird';
import Eventemitter from 'eventemitter3';

export default (ctx) => {
  // Должна быть выключена двухфакторная авторизация
  // Пример конфига
  // {
  //   "user": "email",
  //   "password": "qwertyui",
  //   "host": "imap.gmail.com",
  //   "port": "993",
  //   "tls": true
  // }
  return class MailerParserModule {
    async init() {
      // parser
      this.prefix = 'mailer';
      this.config = get(ctx, 'config.mailer');
      this.defaultConfig = {
        log: {
          level: 'error',
        },
        interval: 60000,
        timeout: 300000,
        limit: 100,
        mailboxDelay: 500,
        boxDelay: 500,
      };
      if (this.config) {
        this.config = merge({}, this.defaultConfig, this.config);
      }
      this.models = require('./models').default(ctx, this);
      this.emitter = new Eventemitter();
    }
    async run() {
      if (!this.config) return;
      this.logger = ctx.createLogger({
        ...this.config.log,
        name: 'mailer',
      });
      this.logger.trace('imap debug');
      this.logger.trace('imap interval', this.config.interval);
      // try {
      //   // console.time('imapParse');
      //   // await this.sync({ box: 'INBOX' });
      //   // await this.sync({ box: config.boxes.inbox });
      //   this.runCron();
      //   // console.timeEnd('imapParse');
      // } catch (err) {
      //   console.error('imap run', err);  //eslint-disable-line
      // }
    }
    log(...args) {
      if (this.config.debug) {
        this.logger.trace(...args);
      }
    }
    stop() {
      this.logger.trace('parser stop');
      // forEach(this.connections, (connection) => {
      //   this.disconnect({ connection });
      // });
    }
    async syncAll() {
      this.logger.trace('syncAll');
      const { mailboxes = [], boxDelay, mailboxDelay } = this.config;
      await Promise.mapSeries(mailboxes, async (mailbox) => {
        let boxes = get(mailbox, 'imap.boxes');
        const imapConfig = get(mailbox, 'imap.config');
        if (!imapConfig) return;
        if (!boxes) {
          try {
            boxes = await this.getBoxes(imapConfig);
          } catch (err) {
            return;
          }
        }
        await Promise.mapSeries(boxes, async (box) => {
          const { boxName } = box;
          let connection;
          try {
            connection = await this.createConnection({ box, mailbox });
          } catch (err) {
            this.disconnect({ connection });
          }
          try {
            await this.sync({
              ...box, connection, mailbox, box: box.boxName,
            });
          } catch (err) {
            console.error('sync err', err);
          }
          this.disconnect({ connection });
          if (boxDelay) {
            await Promise.delay(boxDelay);
          }
        });
        if (mailboxDelay) {
          await Promise.delay(mailboxDelay);
        }
      });
    }
    async runCron() {
      try {
        await this.syncAll();
      } catch (err) {
        this.logger.error('imap syncAll', err);  //eslint-disable-line
      }
      // console.log(config.interval, 'config.interval');
      setTimeout(() => this.runCron(), this.config.interval);
    }
    async createConnection({ box, mailbox }) {
      if (!box) throw '!box';
      if (!mailbox) throw '!mailbox';
      const { boxName } = box;
      return new Promise((resolve, reject) => {
        const connection = new Imap(mailbox.imap.config);
        this.logger.trace('createConnection...', { box });
        function openInbox(cb) {
          connection.openBox(boxName, true, cb);
        }
        let isReady = false;
        connection.once('ready', () => {
          this.logger.trace('openBox', box);
          openInbox((err) => {
            if (err) {
              this.logger.trace('imap openBox error', err);
              return reject(err);
            }
            isReady = true;
            this.logger.trace('imap box opened', { box });
            connection.removeAllListeners();
            return resolve(connection);
          });
        });
        connection.on('error', (err) => {
          this.logger.error('imap connection error', err);
          connection.removeAllListeners();
          return reject(err);
        });
        connection.on('end', () => {
          // for andruxa debug
          this.logger.trace('imap connection end', { box });
          if (!isReady) {
            connection.removeAllListeners();
            reject();
          }
        });
        connection.connect();
      });
    }
    disconnect({ connection }) {
      if (!this.config) throw '!config';
      if (!connection) throw '!connection';
      return new Promise((resolve, reject) => {
        return connection.end((err, res) => {
          connection.removeAllListeners();
          if (err) {
            this.logger.error(err);
            return reject(err);
          }
          return resolve(res);
        });
      });
    }
    async saveEmail({
      message, mailbox, box,
    }) {
      const { Email } = this.models;
      let isExist;
      const countParams = {
        uid: message.uid,
        'from.address': message.from.address,
        'to.address': message.to.address,
        'info.box': box,
        'info.mailbox': mailbox.imap.config.user,
      };
      if (Email.countDocuments) {
        isExist = await Email.countDocuments(countParams);
      } else {
        isExist = await Email.count(countParams);
      }
      if (isExist) return;
      if (message['x-lsk-user-id']) {
        set(message.from, 'userId', message['x-lsk-user-id']);
      }
      // console.log('saveEmail', JSON.stringify({ mailbox, box }, null, 4));
      const mailboxUser = get(mailbox, 'imap.config.user');
      let subtype;
      if (message.from.address === mailboxUser) {
        subtype = 'o';
      } else {
        subtype = 'i';
      }
      const email = new Email({
        uid: message.uid,
        from: message.from,
        to: message.to,
        subtype,
        info: {
          date: message.date,
          text: message.text,
          html: message.html,
          receivedDate: message.receivedDate,
          subject: message.subject,
          references: message.references,
          messageId: message.messageId,
          cc: message.cc,
          bcc: message.bcc,
          mailbox: mailboxUser,
          box,
        },
        meta: {
          'x-gm-thrid': message['x-gm-thrid'],
          'x-lsk-user-id': message['x-lsk-user-id'],
        },
      });
      await email.save();
      this.emitter.emit('models.Email.created', { email });
    }
    _getBoxes({
      box, boxName, parentBoxName = '', result, delimiter = '',
    }) {
      if (!box.children) {
        result.push({ boxName: `${parentBoxName}${delimiter}${boxName}` });
      } else {
        forEach(box.children, (childrenBox, key) => {
          this._getBoxes({
            box: childrenBox,
            boxName: key,
            parentBoxName:
            boxName,
            delimiter:
            box.delimiter,
            result,
          });
        });
      }
      return result;
    }
    async getBoxes(imapConfig) {
      const result = [];
      this.logger.trace('imap getBoxes');
      const connection = new Imap(imapConfig);
      connection.connect();
      return new Promise((resolve, reject) => {
        connection.once('ready', () => {
          return connection.getBoxes((err, boxes) => { // На всякий случай
            if (err) {
              console.error('getBoxes', err);  //eslint-disable-line
              return reject(err);
            }
            this.disconnect({ connection });
            connection.removeAllListeners();
            forEach(boxes, (box, boxName) => {
              this._getBoxes({ box, boxName, result });
            });
            this.logger.trace('imap getBoxes:result', result);
            return resolve(result);
          });
        });
        connection.on('error', (err) => {
          this.logger.error('imap getBoxes error', err);
          connection.removeAllListeners();
          return reject(err);
        });
      });
    }
    async sync({
      box = 'INBOX', connection, mailbox,
    }) {
      const { Email } = this.models;
      const findParams = {
        'info.date': {
          $exists: true,
        },
        'info.mailbox': mailbox.imap.config.user,
        'info.box': box,
      };
      const lastEmail = await Email
        .findOne(findParams)
        .sort({ 'info.date': -1 })
        .select(['info.date']);
      const filter = [];
      if (lastEmail) {
        try {
          const date = m(lastEmail.info.date)
            .add(-1, 'day')
            .locale('en')
            .format('LL');
          filter.push(['SINCE', date]);
        } catch (err) {
          this.logger.error('imap, sync date error', err);
        }
      }
      this.logger.trace('imap filter', filter);
      if (!filter.length) filter.push('ALL');
      try {
        await this.searchAndSave({
          filter, box, connection, mailbox,
        });
      } catch (err) {
        connection.removeAllListeners();
        this.logger.error('imap searchAndSave', err);
      }
    }
    async getMessages(f, length) {
      const messages = [];
      this.logger.trace('imap getMessages start', length);
      return new Promise((resolve, reject) => {
        // const fetchTimeout = setTimeout(() => {
        //   reject(new Error('timeout'));
        // }, this.config.timeout);
        f.on('message', (msg) => {
          const mp = new MailParser();
          msg.on('body', (stream) => {
            const message = {};
            msg.on('attributes', (attrs) => {
              message.attrs = attrs;
              stream.pipe(mp);
              mp.on('headers', (headers) => {
                message.headers = headers;
                mp.on('data', async (obj) => {
                  message.obj = obj;
                  messages.push(message);
                  this.logger.trace(`${messages.length}/${length}`, 'getMessages');
                  mp.removeAllListeners();
                  msg.removeAllListeners();
                  if (messages.length === length) {
                    f.removeAllListeners();
                    resolve(messages);
                  }
                }).on('error', (dataError) => {
                  this.logger.error('imap getMessages f on data', dataError)  //eslint-disable-line
                  mp.removeAllListeners();
                  msg.removeAllListeners();
                  f.removeAllListeners();
                  reject(dataError);
                });
              }).on('error', (headersError) => {
                this.logger.error('imap getMessages f on headers', headersError)  //eslint-disable-line
                mp.removeAllListeners();
                msg.removeAllListeners();
                f.removeAllListeners();
                reject(headersError);
              });
            }).on('error', (attrErrors) => {
              this.logger.error('imap getMessages f on attributes', attrErrors)  //eslint-disable-line
              msg.removeAllListeners();
              f.removeAllListeners();
              reject(attrErrors);
            });
          }).on('error', (bodyError) => {
            this.logger.error('imap getMessages f on body', bodyError)  //eslint-disable-line
            msg.removeAllListeners();
            f.removeAllListeners();
            reject(bodyError);
          });
        }).on('error', (error) => {
          this.logger.error('imap getMessages f on message', error)  //eslint-disable-line
          f.removeAllListeners();
          reject(error);
        });
      });
    }
    async searchAndSave({
      filter, connection, box, mailbox,
    }) {
      this.logger.trace('imap searchAndSave', { filter, box });
      return new Promise((resolve, reject) => {
        try {
          // const fetchTimeout = setTimeout(() => {
          //   reject(new Error('timeout'));
          // }, this.config.timeout);
          // если парсить слишком долго, завис, то заканчиваем парсинг
          this.logger.trace('imap search', { box, filter, mailbox });
          return connection.search(filter, async (searchErr, results) => {
            this.logger.trace('imap search result', { searchErr, results });
            if (searchErr) return reject(searchErr);
            if (!results.length) return resolve([]);
            const { Email } = this.models;
            const findParams = {
              uid: {
                $in: results,
              },
              'info.box': box,
              'info.mailbox': mailbox.imap.config.user,
            };
            // if (subtype === 'o' && mailbox.imap.user) {
            //   findParams['from.address'] = mailbox.imap.user;
            // } else if (subtype === 'i' && mailbox.imap.user) {
            //   findParams['to.address'] = mailbox.imap.user;
            // }
            const emails = await Email
              .find(findParams)
              .select(['uid'])
              .lean();
            results = results.filter((uid) => {
              return !find(emails, { uid });
            });
            if (results.length > this.config.limit) {
              results = results.slice(0, this.config.limit);
            }
            if (!results.length) return resolve([]);
            connection.on('error', (err) => {
              this.logger.error('imap connection on error', err);  //eslint-disable-line
              return reject(err);
            });
            const f = connection.fetch(results, {
              bodies: '',
              struct: true,
            });
            const messages = await this.getMessages(f, results.length);
            // clearTimeout(fetchTimeout);
            this.logger.trace('imap getMessages completed');
            await Promise.map(messages, async ({ attrs, obj, headers }, i) => {
              const message = {
                headers: null,
                text: null,
                subject: null,
                html: null,
                uid: null,
              };
              try {
                // console.log(attrs);
                message.uid = attrs.uid;
                message.text = obj.text;
                message.html = obj.html;
                // console.log('////////////////////////////////');
                // console.log(message.text, 'text');
                // console.log(message.headers);
                message.subject = headers.get('subject');
                const from = headers.get('from');
                // console.log({ thrid });
                const to = headers.get('to');
                const cc = headers.get('cc');
                const bcc = headers.get('bcc');
                const messageId = headers.get('message-id');
                const references = headers.get('references');
                let received = headers.get('received');
                const date = headers.get('date');
                // console.log(date);
                if (cc?.value) {
                  message.cc = cc.value;
                }
                if (bcc?.value) {
                  message.bcc = bcc.value;
                }
                if (received) {
                  if (Array.isArray(received)) {
                    received = received[0];
                  }
                  if (received) {
                    const receivedDate = new Date(received.match(/; (.*)/)[1]);
                    message.receivedDate = receivedDate;
                  }
                }
                if (date) {
                  message.date = new Date(date);
                }
                // console.log(references, 'references');
                message.messageId = messageId;
                message.references = references;
                if (from) {
                  message.from = from.value[0];
                }
                if (to) {
                  message.to = to.value[0];
                } else {
                  const deliveredTo = headers.get('delivered-to');
                  if (deliveredTo?.value?.[0]) {
                    message.to = deliveredTo.value[0];
                  }
                }
                if (attrs['x-gm-thrid']) {
                  message['x-gm-thrid'] = attrs['x-gm-thrid']; // Gmail Thread Id
                }
                if (headers.get('x-lsk-user-id')) {
                  message['x-lsk-user-id'] = headers.get('x-lsk-user-id'); // Gmail Thread Id
                }
                await this.saveEmail({
                  message, box, mailbox,
                });
              } catch (parseError) {
                console.error('imap sync search on "data"', parseError);  //eslint-disable-line
              }
              this.logger.trace(`${i + 1}/${results.length}`, 'saveEmail');
            }, { concurrency: 5 });
            this.logger.trace('parse completed', box);
            return resolve();
          });
        } catch (err) {
          this.logger.error('imap search', err);  //eslint-disable-line
          throw err;
        }
      });
    }
  };
};
