const sqlite3 = require('sqlite3').verbose();

// データベース接続を初期化
const db = new sqlite3.Database('./game_gallery.db', (err) => {
  if (err) {
    console.error('データベース接続エラー:', err);
  } else {
    console.log('データベースに接続しました');
    initDatabase();
  }
});

// テーブルを初期化
function initDatabase() {
  // ゲームメディアテーブルを作成（archive_message_idカラムを最初から含める）
  db.run(`CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    message_id TEXT UNIQUE NOT NULL,
    channel_id TEXT NOT NULL,
    archive_message_id TEXT,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    description TEXT
  )`, function(err) {
    if (err) {
      console.error('mediaテーブル作成エラー:', err);
    } else {
      // 古いSQLiteでIF NOT EXISTSが使えないため、PRAGMAでカラムの存在を確認してから追加
      db.all(`PRAGMA table_info(media)`, (pragErr, rows) => {
        if (pragErr) {
          console.log('テーブル情報取得エラー:', pragErr);
          return;
        }
        // archive_message_idカラムが存在しない場合のみALTER TABLEを実行
        const hasColumn = rows.some(row => row.name === 'archive_message_id');
        if (!hasColumn) {
          db.run(`ALTER TABLE media ADD COLUMN archive_message_id TEXT`, (alterErr) => {
            if (alterErr) console.log('カラム追加エラー:', alterErr);
            else console.log('archive_message_idカラムを追加しました');
          });
        }
      });
    }
  });

  // タグテーブル
  db.run(`CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
    UNIQUE(media_id, tag)
  )`);
}

// メディアを追加
function addMedia(guildId, messageId, channelId, archiveMessageId, authorId, authorName, description, tags, callback) {
  db.run(
    `INSERT INTO media (guild_id, message_id, channel_id, archive_message_id, author_id, author_name, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [guildId, messageId, channelId, archiveMessageId, authorId, authorName, description],
    function(err) {
      if (err) return callback(err, null);
      const mediaId = this.lastID;
      
      if (tags && tags.length > 0) {
        const placeholders = tags.map(() => '(?, ?)').join(',');
        const values = [];
        tags.forEach(tag => {
          values.push(mediaId, tag.toLowerCase().trim());
        });
        
        db.run(`INSERT OR IGNORE INTO tags (media_id, tag) VALUES ${placeholders}`, values, (err) => {
          callback(err, mediaId);
        });
      } else {
        callback(null, mediaId);
      }
    }
  );
}

// タグでメディアを検索
function searchMediaByTags(guildId, searchTags, callback) {
  const placeholders = searchTags.map(() => '?').join(',');
  db.all(`
    SELECT m.*, GROUP_CONCAT(t.tag, ', ') as tags
    FROM media m
    LEFT JOIN tags t ON m.id = t.media_id
    WHERE m.guild_id = ?
    AND EXISTS (
      SELECT 1 FROM tags t2 
      WHERE t2.media_id = m.id 
      AND t2.tag IN (${placeholders})
    )
    GROUP BY m.id
  `, [guildId, ...searchTags.map(t => t.toLowerCase())], callback);
}

// ギルドの全メディアを取得
function getAllMedia(guildId, callback) {
  db.all(`
    SELECT m.*, GROUP_CONCAT(t.tag, ', ') as tags
    FROM media m
    LEFT JOIN tags t ON m.id = t.media_id
    WHERE m.guild_id = ?
    GROUP BY m.id
    ORDER BY m.timestamp DESC
  `, [guildId], callback);
}

// 自分が追加したメディアを取得
function getMyMedia(guildId, authorId, callback) {
  db.all(`
    SELECT m.*, GROUP_CONCAT(t.tag, ', ') as tags
    FROM media m
    LEFT JOIN tags t ON m.id = t.media_id
    WHERE m.guild_id = ? AND m.author_id = ?
    GROUP BY m.id
    ORDER BY m.timestamp DESC
  `, [guildId, authorId], callback);
}

// 投稿者名でメディアを検索
function searchMediaByAuthor(guildId, authorName, callback) {
  db.all(`
    SELECT m.*, GROUP_CONCAT(t.tag, ', ') as tags
    FROM media m
    LEFT JOIN tags t ON m.id = t.media_id
    WHERE m.guild_id = ? AND m.author_name LIKE ?
    GROUP BY m.id
    ORDER BY m.timestamp DESC
  `, [guildId, `%${authorName}%`], callback);
}

// メディアを削除
function deleteMedia(guildId, mediaId, callback) {
  db.run(`DELETE FROM media WHERE guild_id = ? AND id = ?`, [guildId, mediaId], function(err) {
    if (err) return callback(err, 0);
    callback(null, this.changes);
  });
}

module.exports = { db, addMedia, searchMediaByTags, getAllMedia, deleteMedia, getMyMedia, searchMediaByAuthor };