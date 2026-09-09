require('dotenv').config();
// 環境変数の存在チェック
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('環境変数DISCORD_TOKENまたはCLIENT_IDが設定されていません！.envファイルまたはGitHub Secretsを確認してください。');
  process.exit(1);
}
const { Client, GatewayIntentBits, Collection, REST, Routes, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { db, addMedia, searchMediaByTags, getAllMedia, deleteMedia, getMyMedia, searchMediaByAuthor } = require('./database.js');

// Botクライアントの初期化
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// スラッシュコマンドの定義
const commands = [
  {
    name: 'add',
    description: 'ゲームのスクリーンショットや動画をギャラリーに追加します',
    options: [
      {
        type: 3,
        name: 'message_link',
        description: '保存したいメッセージのリンク',
        required: true,
      },
      {
        type: 3,
        name: 'tags',
        description: 'カンマ区切りでタグを指定（例：rpg, オープンワールド, steam）',
        required: false,
      },
      {
        type: 3,
        name: 'description',
        description: 'メディアの説明',
        required: false,
      }
    ]
  },
  {
    name: 'gallery',
    description: 'ギャラリーに保存されているメディアの一覧を表示します',
    options: [
      {
        type: 3,
        name: 'tags',
        description: 'フィルタリングするタグ（カンマ区切り、任意）',
        required: false,
      },
      {
        type: 3,
        name: 'author',
        description: '検索する投稿者の名前（任意）',
        required: false,
      }
    ]
  },
  {
    name: 'delete',
    description: 'ギャラリーから指定したIDのメディアを削除します',
    options: [
      {
        type: 4,
        name: 'media_id',
        description: '削除したいメディアのID（/galleryで確認可能）',
        required: true,
      }
    ]
  },
  {
    name: 'help',
    description: 'ゲームギャラリーbotのコマンド一覧と使い方を表示します',
  }
];

// コマンドを登録
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('スラッシュコマンドの登録を開始...');
    
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    
    console.log('スラッシュコマンドの登録が完了しました');
  } catch (error) {
    console.error('コマンド登録エラー:', error);
  }
})();

// アーカイブチャンネルを取得または作成
async function getOrCreateArchiveChannel(guild) {
  // 既存のアーカイブチャンネルを探す
  let archiveChannel = guild.channels.cache.find(ch => ch.name === 'アーカイブ' && ch.isTextBased());
  
  if (!archiveChannel) {
    // サーバー作成者（オーナー）のみが閲覧できるチャンネルを作成
    const owner = await guild.fetchOwner();
    archiveChannel = await guild.channels.create({
      name: 'アーカイブ',
      type: 0, // テキストチャンネル
      permissionOverwrites: [
        {
          id: guild.id, // 全員
          deny: [PermissionsBitField.Flags.ViewChannel]
        },
        {
          id: owner.id, // サーバーオーナー
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]
        },
        {
          id: client.user.id, // Bot自身
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
        }
      ]
    });
    console.log(`[${guild.name}] アーカイブチャンネルを作成しました`);
  }
  return archiveChannel;
}

// メッセージリンクからメッセージを取得
async function fetchMessageFromLink(link, guild) {
  try {
    const match = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) return null;
    
    const [, guildId, channelId, messageId] = match;
    if (guildId !== guild.id) return null;
    
    const channel = await guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return null;
    
    return await channel.messages.fetch(messageId);
  } catch (err) {
    return null;
  }
}

// クライアント起動時
client.on('ready', () => {
  console.log(`ログイン完了: ${client.user.tag}`);
});

// インタラクション処理
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  
  const { commandName, guild } = interaction;
  if (!guild) return;
  
  // コマンド実行者がサーバーオーナーか確認
  const owner = await guild.fetchOwner();
  if (interaction.user.id !== owner.id) {
    return interaction.reply({
      content: 'このコマンドはサーバーオーナーのみが使用できます。',
      ephemeral: true
    });
  }
  
  if (commandName === 'add') {
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const messageLink = interaction.options.getString('message_link');
      const tagsStr = interaction.options.getString('tags');
      const description = interaction.options.getString('description') || '';
      const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];
      
      // メッセージを取得
      const targetMessage = await fetchMessageFromLink(messageLink, guild);
      if (!targetMessage) {
        return interaction.editReply('メッセージが見つかりませんでした。リンクが正しいか確認してください。');
      }
      
      // メディアが含まれているか確認
      const hasAttachments = targetMessage.attachments.size > 0;
      if (!hasAttachments) {
        return interaction.editReply('指定されたメッセージに画像や動画の添付ファイルが含まれていません。');
      }
      
      // archiveチャンネルを取得
      const archiveChannel = await getOrCreateArchiveChannel(guild);
      
      // アーカイブチャンネルに転記
      const galleryEmbed = new EmbedBuilder()
        .setTitle('🎮 ゲームギャラリーに追加')
        .setDescription(description || '説明なし')
        .addFields(
          { name: '投稿者', value: `<@${targetMessage.author.id}>`, inline: true },
          { name: '元のメッセージ', value: `[リンク](${messageLink})`, inline: true }
        )
        .setTimestamp()
        .setColor(0x5865F2);
      
      if (tags.length > 0) {
        galleryEmbed.addFields({ name: 'タグ', value: tags.map(t => `#${t}`).join(' ') });
      }
      
      // 最初の添付ファイルを埋め込み
      const firstAttachment = targetMessage.attachments.first();
      if (firstAttachment && firstAttachment.url) {
        galleryEmbed.setImage(firstAttachment.url);
      }
      
      // 全ての添付ファイルのURLを追加
      let attachmentsText = targetMessage.attachments.map(a => a.url).join('\n');
      const sentMessage = await archiveChannel.send({
        embeds: [galleryEmbed],
        content: `添付ファイル一覧:\n${attachmentsText}`
      });
      
      // データベースに登録（アーカイブチャンネルに投稿したメッセージのIDを正しく渡す）
      addMedia(
        guild.id,
        sentMessage.id,
        archiveChannel.id,
        sentMessage.id,
        interaction.user.id,
        interaction.user.username,
        description,
        tags,
        (err, mediaId) => {
          if (err) {
            console.error('データベース登録エラー:', err);
            return interaction.editReply('データベースへの追加中にエラーが発生しました。');
          }
          interaction.editReply(`✅ ゲームギャラリーに追加しました！\nID: ${mediaId}\n#${tags.join(' #')}`);
        }
      );
      
    } catch (error) {
      console.error('addコマンドエラー:', error);
      interaction.editReply('コマンドの実行中にエラーが発生しました。');
    }
  }
  
  if (commandName === 'gallery') {
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const tagsStr = interaction.options.getString('tags');
      const authorStr = interaction.options.getString('author');
      const searchTags = tagsStr ? tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(t => t) : [];
      
      let results;
      if (authorStr) {
        results = await new Promise((resolve, reject) => {
          searchMediaByAuthor(guild.id, authorStr, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          });
        });
      } else if (searchTags.length > 0) {
        results = await new Promise((resolve, reject) => {
          searchMediaByTags(guild.id, searchTags, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          });
        });
      } else {
        results = await new Promise((resolve, reject) => {
          getMyMedia(guild.id, interaction.user.id, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          });
        });
      }
      
      if (!results || results.length === 0) {
        return interaction.editReply('ゲームギャラリーに保存されたメディアが見つかりませんでした。');
      }
      
      // 埋め込みで一覧を表示
      let title = `🎮 ゲームギャラリー一覧 (${results.length}件)`;
      if (authorStr) {
        title = `🎮 投稿者検索結果: 「${authorStr}」さんの投稿 (${results.length}件)`;
      } else if (searchTags.length > 0) {
        title = `🎮 タグ検索結果: #${searchTags.join(' #')} (${results.length}件)`;
      } else {
        title = `🎮 あなたの投稿 (${results.length}件)`;
      }
      
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x57F287)
        .setTimestamp();
      
      // 最大10件まで表示
      const displayItems = results.slice(0, 10);
      displayItems.forEach(item => {
        const channel = guild.channels.cache.get(item.channel_id);
        const jumpUrl = channel ? `https://discord.com/channels/${guild.id}/${item.channel_id}/${item.message_id}` : 'リンク無効';
        embed.addFields({
          name: `ID: ${item.id} - ${new Date(item.timestamp).toLocaleDateString('ja-JP')}`,
          value: `投稿者: ${item.author_name}\nタグ: ${item.tags || 'なし'}\n[ギャラリーメッセージへ](${jumpUrl})`
        });
      });
      
      if (results.length > 10) {
        embed.setFooter({ text: `...他${results.length - 10}件が存在します` });
      }
      
      await interaction.editReply({ embeds: [embed] });
      
    } catch (error) {
        console.error('galleryコマンドエラー:', error);
        interaction.editReply('コマンドの実行中にエラーが発生しました。');
      }
  }
  
  if (commandName === 'delete') {
    await interaction.deferReply({ ephemeral: true });
    
    try {
      const mediaId = interaction.options.getInteger('media_id');
      
      // データベースからメディア情報と投稿者IDを取得（本人確認のため）
      db.get(`SELECT archive_message_id, author_id FROM media WHERE guild_id = ? AND id = ?`, [guild.id, mediaId], async (err, row) => {
        if (err || !row) {
          console.error('メディア取得エラー:', err);
          return interaction.editReply(`指定されたID:${mediaId}のメディアが見つかりませんでした。IDが正しいか確認してください。`);
        }

        // 投稿者本人、またはサーバーオーナー以外は削除不可
        if (row.author_id !== interaction.user.id && interaction.user.id !== guild.ownerId) {
          return interaction.editReply('このメディアを削除する権限がありません。自分が投稿したメディアのみ削除可能です。');
        }

        // アーカイブチャンネルのメッセージを削除
        const archiveChannel = await getOrCreateArchiveChannel(guild);
        if (archiveChannel && row.archive_message_id) {
          try {
            const archiveMessage = await archiveChannel.messages.fetch(row.archive_message_id);
            if (archiveMessage) {
              await archiveMessage.delete();
              console.log(`[${guild.name}] アーカイブチャンネルのメッセージ${row.archive_message_id}を削除しました`);
            }
          } catch (msgErr) {
            console.log('アーカイブメッセージの削除に失敗（既に削除済みの可能性あり）:', msgErr);
          }
        }

        // データベースから削除
        deleteMedia(guild.id, mediaId, async (err, changes) => {
          if (err) {
            console.error('データベース削除エラー:', err);
            return interaction.editReply('削除中にエラーが発生しました。');
          }
          
          interaction.editReply(`✅ ID:${mediaId}のメディアをアーカイブからも削除しました。`);
        });
      });
      
    } catch (error) {
      console.error('deleteコマンドエラー:', error);
      interaction.editReply('コマンドの実行中にエラーが発生しました。');
    }
  }
  
  if (commandName === 'help') {
    await interaction.deferReply({ ephemeral: true });
    
    const helpEmbed = new EmbedBuilder()
      .setTitle('🎮 ゲームギャラリーbot 使い方ガイド')
      .setColor(0x2ecc71)
      .addFields(
        {
          name: '/add <message_link> [tags] [description]',
          value: 'ゲームのスクリーンショットや動画をギャラリーに追加します。\n**message_link**: 保存したいメッセージのリンク（必須）\n**tags**: カンマ区切りのタグ（任意）\n**description**: メディアの説明（任意）\n投稿したメディアはサーバー内の「アーカイブ」チャンネルにも保存されます。'
        },
        {
          name: '/gallery [tags] [author]',
          value: 'ギャラリーに保存されているメディアの一覧を表示します。\n**tags**: フィルタリングするタグ（任意）\n**author**: 検索する投稿者の名前（部分一致で検索可能、任意）\n✅ デフォルト：自分が追加したメディアだけを表示\n✅ authorパラメータで他のユーザーの投稿も検索可能\nボタンでページ送りが可能で、1ページに10件表示されます。'
        },
        {
          name: '/delete <media_id>',
          value: 'ギャラリーから指定したIDのメディアを削除します。\n**media_id**: 削除したいメディアのID（/galleryで確認可能、必須）\n✅ 削除可能なユーザー：\n・メディアを投稿した本人\n・サーバーオーナー\n※削除するとBotのギャラリーと「アーカイブ」チャンネルの両方から削除されます。'
        },
        {
          name: '/help',
          value: 'このヘルプメッセージを表示します。'
        }
      )
      .setFooter({ text: 'メッセージリンクの取得方法：Discordのメッセージを右クリック→「メッセージリンクをコピー」' });
    
    await interaction.editReply({ embeds: [helpEmbed] });
  }
});

// Botログイン
client.login(process.env.DISCORD_TOKEN);