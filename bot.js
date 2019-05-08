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
    disabledEvents: ['GUILD_ROLE_CREATE', 'GUILD_ROLE_DELETE', 'GUILD_ROLE_UPDATE', 'CHANNEL_UPDATE', 'CHANNEL_PINS_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE_BULK', 'USER_UPDATE', 'USER_NOTE_UPDATE', 'USER_SETTINGS_UPDATE', 'PRESENCE_UPDATE', 'VOICE_STATE_UPDATE', 'TYPING_START', 'VOICE_SERVER_UPDATE', 'RELATIONSHIP_ADD', 'RELATIONSHIP_REMOVE'],
});
client.on('disconnect', Shutdown);
client.on('error', console.warn);
client.on('reconnecting', console.log);
client.on('resume', console.log);
client.on('rateLimit', console.warn);

const blacklistDb = new Database({ filename: './storage/users.db', autoload: true });

const
    RemoveMentions = str => str.replace(Discord.MessageMentions.USERS_PATTERN, ''),
    GetMentions = str => str.match(Discord.MessageMentions.USERS_PATTERN);

const helpText = `**Справка**

Префикс: **${config.prefix}**

Команды:
**add** <@user> [reason] - добавить указанных пользователей в черный список с указанием причины.
**remove** <@user> - убрать указанных пользователей из черного списка.
**info** <@user> - информация об указанном пользователе.
**cleanup** <count> - удалить указанное количество последних сообщений на канале. За один раз можно удалить максимум 100 сообщений.
**stats** - статистика.
**help** - показать данное справочное сообщение.

Параметры:
<param> - обязательный параметр.
[param] - необязательный параметр.`;

const botCommands = {
    
    //Добавление в черный список
    add: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.BAN_MEMBERS))
            return;
        
        if(!message.mentions.members)
            return;
        
        const
            reason = RemoveMentions(message.content).trim(),
            dt = Date.now();
        
        //Реализуем через members. Защита от потенциальной возможности добавить людей, не находящихся на данном сервере.
        for(const target of message.mentions.members.values()) {
            if(target.id == client.user.id) {
                message.reply(':(');
                continue;
            }
            
            //Не трогаем админсостав
            if(target.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES)) {
                message.reply(`нельзя забанить пользователя ${target.toString()}, так как он является представителем администрации сервера.`);
                continue;
            }
            
            target.ban({ days: 1, reason: reason });
            
            const userInfo = await blacklistDb.findOne({ _id: target.id });
            if(userInfo) {
                message.reply(`пользователь ${target.toString()} уже находится в черном списке.`);
            } else {
                await blacklistDb.insert({ _id: target.id, server: message.guild.id, moder: message.author.id, date: dt, reason: reason });
                message.guild.systemChannel.send(`Модератор ${message.member.toString()} добавил пользователя ${target.toString()} в черный список.${reason ? `\nПричина: ${reason}` : ''}`);
                NotifyAllServers(message.guild.id, target.id, true);
            }
        }
    },
    
    //Удаление из черного списка
    remove: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.BAN_MEMBERS))
            return;
        
        //Реализуем через ручной поиск упоминаний юзеров, так как пользователь может быть не на сервере.
        const mentions = GetMentions(message.content);
        if(!mentions)
            return;
        
        const reason = RemoveMentions(message.content).trim();
        
        for(let i = 0; i < mentions.length; i++) {
            const match = mentions[i].match(/[0-9]+/);
            if(!match)
                continue;
            
            const
                id = match[0],
                userInfo = await blacklistDb.findOne({ _id: id });
            
            if(userInfo) {
                await blacklistDb.remove({ _id: id });
                await message.guild.unban(id, reason);
                message.guild.systemChannel.send(`Модератор ${message.member.toString()} убрал пользователя <@${id}> из черного списка.${reason ? `\nПричина: ${reason}` : ''}`);
                NotifyAllServers(message.guild.id, id, false);
            } else {
                message.reply(`пользователь <@${id}> не находится в черном списке.`);
            }
        }
    },
    
    //Выдача информации о состоянии пользователя
    info: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
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
                userInfo = await blacklistDb.findOne({ _id: id });
            
            if(userInfo)
                message.channel.send(`**Информация**\nПользователь <@${id}> находится в черном списке.\nСервер: ${client.guilds.get(userInfo.server).name} (${userInfo.server})\nМодератор: <@${userInfo.moder}>\nДата добавления: ${Util.DtString(userInfo.date)}\nПричина: ${userInfo.reason}`);
            else
                message.channel.send(`**Информация**\nПользователь <@${id}> не находится в черном списке.`);
        }
    },
    
    //Удаление сообщений
    cleanup: async (message) => {
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const count = parseInt(message.content);
        if(count && (count > 0))
            message.channel.bulkDelete(count);
    },
    
    //Выдача статистики
    stats: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        const count = await blacklistDb.count({});
        message.channel.send(`**Статистика**\nВсего пользователей в черном списке: ${count}\nПодключено серверов: ${client.guilds.size}`);
    },
    
    //Справка по боту
    help: async (message) => {
        //Предположительно пока даем получать информацию только модераторам
        if(!message.member.hasPermission(Discord.Permissions.FLAGS.MANAGE_MESSAGES))
            return;
        
        message.channel.send(helpText);
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
    
    await member.ban({ days: 1, reason: 'Автоматический бан' });
    member.guild.systemChannel.send(`Пользователь ${member.toString()} находится в черном списке! Выдан автоматический бан.`);
    
    return true;
}

async function CheckSpam(message) {
    if(message.content.search(/discord\s*\.\s*gg/gim) > -1) {
        await blacklistDb.insert({ _id: message.author.id, server: message.guild.id, moder: client.user.id, date: Date.now(), reason: 'Автоматический бан по причине спама' });
        await message.member.ban({ days: 1, reason: 'Автоматический бан по причине спама' });
        message.guild.systemChannel.send(`Пользователь ${message.member.toString()} автоматически добавлен в черный список по причине спама.`);
        NotifyAllServers(message.guild.id, message.author.id, true);
        return true;
    }
    return false;
}

async function NotifyServer(server, userId, mode) {
    if(mode) {
        await server.ban(userId, { days: 1, reason: 'Автоматический бан' });
        server.systemChannel.send(`Пользователь <@${userId}> был добавлен в черный список на другом сервере. Выдан автоматический бан.`);
    } else {
        await server.unban(userId);
        server.systemChannel.send(`Пользователь <@${userId}> был убран из черного списка на другом сервере. Бан снят автоматически.`);
    }
}

async function NotifyAllServers(thisServerId, userId, mode) {
    for(const server of client.guilds.values())
        if(server.id != thisServerId)
            NotifyServer(server, userId, mode);
}

client.on('guildMemberAdd', CheckBanned);

client.on('message', async (message) => {
    if(!(message.content && message.member))
        return;
    
    if(message.author.id == client.user.id)
        return;
    
    if((message.member.joinedTimestamp > Date.now() - config.banJoinPeriod) && await CheckSpam(message))
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
});

client.login(process.env.TOKEN);
