"use strict";

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);

function Shutdown(err) {
    console.error(err);
    process.exit(1);
}

if(!process.env.TOKEN)
    Shutdown('Необходим токен!');

const
    config = require('./config.json'),
    Util = require('./util.js'),
    Discord = require('discord.js'),
    Database = require('nedb-promise');

const client = new Discord.Client({
    messageCacheMaxSize: 1,
    disabledEvents: ['CHANNEL_PINS_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_UPDATE', 'USER_UPDATE', 'USER_NOTE_UPDATE', 'USER_SETTINGS_UPDATE', 'PRESENCE_UPDATE', 'VOICE_STATE_UPDATE', 'TYPING_START', 'VOICE_SERVER_UPDATE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE'],
});
client.on('disconnect', Shutdown);
client.on('error', console.warn);
client.on('reconnecting', console.log);
client.on('resume', console.log);
client.on('rateLimit', console.warn);

const
    blacklistDb = new Database({ filename: './storage/users.db', autoload: true }),
    serversDb = new Database({ filename: './storage/servers.db', autoload: true });

const
    RemoveMentions = str => str.replace(Discord.MessageMentions.USERS_PATTERN, ''),
    GetMentions = str => str.match(Discord.MessageMentions.USERS_PATTERN);

const
    userHelp = `**Команды пользователя**
\`link\` - показать ссылку на приглашение бота.
\`help\` - показать данное справочное сообщение.`,
    
    moderHelp = `**Команды модератора**
\`cleanup N\` - удалить N последних сообщений на канале. За один раз можно удалить максимум 100 сообщений.
\`info @user\` - показать информацию об указанных пользователях из черного списка.
\`blacklist\` - показать список всех пользователей в черном списке.`,
    
    adminHelp = `**Команды администратора**
\`channel #канал\` - установка канала для информационных сообщений бота. Если канал не указан, параметр будет очищен.
\`stats\` - показать статистику.
\`serverlist\` - показать список всех подключенных к боту серверов.`,
    
    serviceHelp = `**Сервисные команды**
\`add @user причина\` - добавить указанных пользователей в черный список с указанием причины.
\`remove @user\` - убрать указанных пользователей из черного списка.
\`trust id\` - добавить сервер с указанным идентификатором в доверенные.
\`untrust id\` - убрать сервер с указанным идентификатором из доверенных.`;

const botCommands = {
    
    //Установка канала для информационных сообщений бота
    channel: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            return;
        
        const channel = message.mentions.channels.first();
        if(channel) {
            const perms = channel.permissionsFor(message.guild.me);
            if(!perms.has(Discord.Permissions.FLAGS.READ_MESSAGES)) {
                message.reply('нет права доступа к указанному каналу!');
                return;
            }
            if(!perms.has(Discord.Permissions.FLAGS.SEND_MESSAGES)) {
                message.reply('нет права на размещение сообщений в указанном канале!');
                return;
            }
            await serversDb.update({ _id: message.guild.id }, { $set: { channel: channel.id } }, { upsert: true });
            message.reply('канал установлен.');
        } else {
            await serversDb.update({ _id: message.guild.id }, { $unset: { channel: true } });
            message.reply('канал сброшен.');
        }
        
    },
    
    //Выдача информации о состоянии пользователя
    info: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const
                id = match[0],
                userInfo = await blacklistDb.findOne({ _id: id }),
                server = client.guilds.get(userInfo.server);
            
            if(userInfo)
                message.channel.send(`**Информация**\nПользователь: <@${id}>\nТег: ${(await client.fetchUser(id, false)).tag}\nСервер: ${server ? `\`${server.name}\` (${server.id})` : userInfo.server} \nМодератор: <@${userInfo.moder}>\nДата добавления: ${Util.DtString(userInfo.date)}\nПричина: ${userInfo.reason}`);
            else
                message.channel.send(`**Информация**\nПользователь <@${id}> не находится в черном списке.`);
        }
    },
    
    //Выдача списка всех пользователей в черном списке
    blacklist: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const users = await blacklistDb.find({});
        
        await message.channel.send(`**Черный список**\nВсего пользователей: ${users.length}\n*Список будет подгружаться частями, это может занять некоторое время.*`);
        let text = '```py\n';
        for(let i = 0; i < users.length; i++) {
            const
                id = users[i]._id,
                user = await client.fetchUser(id, false),
                add = `<@${id}> → ${user.tag}\n`;
            
            if(text.length + add.length < 1990) {
                text += add;
            } else {
                await message.channel.send(text + '```');
                text = '```py\n' + add;
            }
        }
        await message.channel.send(text + '```');
    },
    
    //Удаление сообщений
    cleanup: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const count = parseInt(message.content);
        if(count && (count > 0))
            message.channel.bulkDelete(Math.min(count, 100));
    },
    
    //Выдача статистики
    stats: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            return;
        
        const count = await blacklistDb.count({});
        message.channel.send(`**Статистика**\nПользователей в черном списке: ${count}\nПодключено серверов: ${client.guilds.size}`);
    },
    
    //Выдача списка всех подключенных серверов
    serverlist: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            return;
        
        let msg = `**Список серверов**\nВсего ${client.guilds.size}\n\`\`\`css\n`;
        for(const server of client.guilds.values()) {
            const info = await serversDb.findOne({ _id: server.id });
            msg += `[${(info && info.trusted) ? 'v' : ' '}] | ${server.id} | ${server.name}\n`;
        }
        msg += '```';
        
        message.channel.send(msg);
    },
    
    //Ссылка на приглашение бота
    link: async (message) => {
        message.reply(`<${await client.generateInvite(523334)}>`);
    },
    
    //Справка по боту
    help: async (message) => {
        let text = `**Справка**\n\n${userHelp}\n\n`;
        
        if(message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            text += `${moderHelp}\n\n`;
        
        if(message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_CHANNELS))
            text += `${adminHelp}\n\n`;
        
        if(message.channel.id == config.serviceChannel)
            text += `${serviceHelp}\n\n`;
        
        message.channel.send(text);
    },
    
    //Суперадминские команды, работают только в сервисном канале
    //Добавление в черный список
    add: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        const
            reason = RemoveMentions(message.content).trim(),
            dt = Date.now();
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const user = await client.fetchUser(match[0], false);
            if(!user) {
                message.reply(`пользователь с идентификатором **${match[0]}** не существует.`);
                continue;
            }
            
            if(user.id == client.user.id) {
                message.reply(':(');
                continue;
            }
            
            SpreadBan(user.id, true, reason);
            
            const userInfo = await blacklistDb.findOne({ _id: user.id });
            if(userInfo) {
                if(reason)
                    await blacklistDb.update({ _id: user.id }, { $set: { reason: reason } });
                
                message.reply(`пользователь ${user.toString()} уже находится в черном списке. ${reason ? '\nПричина обновлена.' : ''}`);
            } else {
                await blacklistDb.insert({ _id: user.id, server: message.guild.id, moder: message.author.id, date: dt, reason: reason });
                ServiceLog(`Модератор ${message.member.toString()} добавил пользователя ${user.toString()} в черный список.${reason ? `\nПричина: ${reason}` : ''}`);
            }
        }
    },
    
    //Удаление из черного списка
    remove: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const
                id = match[0],
                userInfo = await blacklistDb.findOne({ _id: id });
            
            if(userInfo) {
                await blacklistDb.remove({ _id: id });
                SpreadBan(user.id, false);
                ServiceLog(`Модератор ${message.member.toString()} убрал пользователя <@${id}> из черного списка.`);
            } else {
                message.reply(`пользователь <@${id}> не находится в черном списке.`);
            }
        }
    },
    
    //Добавление доверенного сервера
    trust: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const match = message.content.match(/[0-9]+/);
        if(!match)
            return;
        
        const
            id = match[0],
            server = client.guilds.get(id),
            info = await serversDb.findOne({ _id: id });
        
        if(info && info.trusted) {
            message.reply(`${server ? `сервер \`${server.name}\` (${server.id})` : `идентификатор \`${id}\``} уже находится в списке доверенных.`);
            return;
        }
        
        if(info)
            await serversDb.update({ _id: id }, { $set: { trusted: true } });
        else
            await serversDb.insert({ _id: id, trusted: true });
        
        ServiceLog(`Модератор ${message.author.toString()} добавил ${server ? `сервер \`${server.name}\` (${server.id})` : `идентификатор \`${id}\``} в список доверенных.`);
    },
    
    //Удаление доверенного сервера
    untrust: async (message) => {
        if(message.channel.id != config.serviceChannel)
            return;
        
        const match = message.content.match(/[0-9]+/);
        if(!match)
            return;
        
        const
            id = match[0],
            server = client.guilds.get(id),
            info = await serversDb.findOne({ _id: id });
        
        if(!(info && info.trusted)) {
            message.reply(`${server ? `сервер \`${server.name}\` (${server.id})` : `идентификатор \`${id}\``} отсутствует в списке доверенных.`);
            return;
        }
        
        await serversDb.update({ _id: id }, { $unset: { trusted: true } });
        
        ServiceLog(`Модератор ${message.author.toString()} удалил ${server ? `сервер \`${server.name}\` (${server.id})` : `идентификатор \`${id}\``} из списка доверенных.`);
    },
    
};

//Проверка пользователя в черном списке
async function CheckBanned(member) {
    //Не трогаем админсостав
    if(member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
        return false;
    
    const userInfo = await blacklistDb.findOne({ _id: member.id });
    if(!userInfo)
        return false;
    
    const server = member.guild;
    try {
        await member.ban({ days: 1, reason: userInfo.reason });
    } catch {
        Notify(server, `Не удалось выдать бан пользователю из черного списка ${member.toString()}! У бота недостаточно прав, либо роль пользователя находится выше роли бота.`);
        return true;
    }
    Notify(server, `Пользователю ${member.toString()} из черного списка выдан автоматический бан!\nУказанная причина: ${userInfo.reason}`);
    
    return true;
}

const suspiciousUsers = new Map();
async function CheckSpam(message) {
    //Не трогаем админсостав
    if(message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
        return false;
    
    const code = Util.GetInviteCode(message.content);
    if(!code)
        return false;
    
    let invite;
    try {
        invite = await client.rest.methods.getInvite(code);
    } catch {}
    
    if(invite) {
        if(invite.guild.id == message.guild.id)
            return false;
        
        const info = await serversDb.findOne({ _id: invite.guild.id });
        if(info && info.trusted)
            return false;
    }
    
    const now = Date.now();
    let resident = false;
    if(message.member.joinedTimestamp < now - config.banJoinPeriod) {
        resident = true;
    } else {
        for(const server of client.guilds.values()) {
            if(server.id == message.guild.id)
                continue;
            
            try {
                if((await server.fetchMember(message.author.id)).joinedTimestamp < now - config.banJoinPeriod) {
                    resident = true;
                    break;
                }
            } catch {}
        }
    }
    
    const
        server = message.guild,
        user = message.author;
    
    if(resident) {
        if(suspiciousUsers.has(user.id)) {
            await message.delete();
            user.send(`Обнаружено злоупотребление инвайтами. Сообщение удалено.`);
            Notify(server, `Злоупотребление инвайтами от пользователя ${user.toString()}. Сообщение удалено, пользователю выслано предупреждение.\n\n**Содержимое сообщения**\`\`\`${message.content}\`\`\``);
            clearTimeout(suspiciousUsers.get(user.id));
        }
        suspiciousUsers.set(user.id, setTimeout(suspiciousUsers.delete, config.suspiciousTimeout, user.id));
    } else {
        if(suspiciousUsers.has(user.id)) {
            await blacklistDb.insert({ _id: user.id, server: server.id, moder: client.user.id, date: Date.now(), reason: 'Автоматически: сторонний пользователь, спам сторонним инвайтом' });
            Notify(server, `Пользователь ${user.toString()} автоматически добавлен в черный список.\n\n**Содержимое сообщения**\`\`\`${message.content}\`\`\``);
            try {
                await message.member.ban({ days: 1, reason: 'Автоматический бан' });
            } catch {
                Notify(server, `Не удалось забанить пользователя ${user.toString()} на сервере! У бота недостаточно прав, либо роль пользователя находится выше роли бота.`);
            }
            suspiciousUsers.delete(user.id);
        } else {
            await message.delete();
            suspiciousUsers.set(user.id, 0);
            user.send(`Обнаружена попытка спама на сервере \`${server.name}\`. Сообщение удалено. Повторная попытка спама приведет к бану.`);
            Notify(server, `Сторонний пользователь ${user.toString()} разместил стороннее приглашение. Сообщение удалено, пользователю выслано предупреждение. Повторная попытка приведет к бану.\n\n**Содержимое сообщения**\`\`\`${message.content}\`\`\``);
        }
    }
    
    return true;
}

//Попытка забанить/разбанить пользователя на всех подключенных серверах
async function SpreadBan(userId, mode, reason) {
    for(const server of client.guilds.values()) {
        if(mode) {
            try {
                await server.ban(userId, reason);
            } catch {
                ServiceLog(`Не удалось забанить пользователя ${user.toString()} на сервере \`${server.name}\` (${server.id})! У бота недостаточно прав, либо роль пользователя находится выше роли бота.`);
            }
        } else {
            try {
                await server.unban(userId);
            } catch {}
        }
    }
}

async function SendInfo(server, msg) {
    const info = await serversDb.findOne({ _id: server.id });
    if(info && info.channel)
        client.channels.get(info.channel).send(msg);
}

async function ServiceLog(msg) {
    client.channels.get(config.serviceChannel).send(msg);
}

async function Notify(server, msg) {
    SendInfo(server, msg);
    ServiceLog(`**Сервер:** \`${server.name}\` (${server.id})\n**Событие:**\n${msg}`);
}

client.on('guildMemberAdd', CheckBanned);

client.on('guildCreate', async (server) => {
    ServiceLog(`**Подключен новый сервер!**\n\`${server.name}\` (${server.id})\nВладелец: ${server.owner.toString()}`);
});
client.on('guildDelete', async (server) => {
    ServiceLog(`**Сервер отключен**\n\`${server.name}\` (${server.id})`);
});

client.on('message', async (message) => {
    if(!(message.content && message.member))
        return;
    
    if(message.author.id == client.user.id)
        return;
    
    if(await CheckBanned(message.member))
        return;
    
    if(await CheckSpam(message))
        return;
    
    if(!message.content.startsWith(config.prefix))
        return;
    
    const
        si = message.content.indexOf(' '),
        command = botCommands[message.content.substring(config.prefix.length, (si > 0) ? si : undefined).toLowerCase()];
    
    if(command) {
        message.content = message.content.substring((si > 0) ? (si + 1) : '');
        command(message);
    }
});

client.on('ready', async () => {
    console.log('READY');
    
    //Очистка пустых записей в базе серверов
    serversDb.remove({ trusted: { $exists: false }, channel: { $exists: false } }, { multi: true });
});

client.login(process.env.TOKEN);
