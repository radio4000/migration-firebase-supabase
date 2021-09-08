import {v4} from 'uuid'

// What's the plan?
// Take firebase: users, channels, tracks
// Insert into postgres: auth users, public users, channels, user_channel, tracks, channel_track

// migrate() controls the flow
// easyDb is a transformed firebase database where each user's data is grouped as an "entity".
// runQueries() takes a single user/entity and insert all data one by one

const migrate = async ({firebaseDatabase: db, postgresClient: client, logs}) => {
	// Clean up
	await client.query('DELETE FROM public.channel_track')
	await client.query('DELETE FROM public.channels')
	await client.query('DELETE FROM public.tracks')
	await client.query('DELETE FROM public.user_channel')
	await client.query('DELETE FROM auth.users')

	// Collect the objects we want in an easier structure to import.

	const total = db.length
	for (const [index, entity] of db.entries()) {
		const {user, channel, tracks} = entity
		console.log(`Inserting ${index + 1} of ${total}`, user?.id, channel?.title || 'no channel', tracks?.length || 'no tracks')
		try {
			await runQueries(client, {user, channel, tracks})
			logs.ok.push(user.id)
		} catch (err) {
			console.log('nop', entity)
			logs.failed.push(user.id)
		}
	}
}

async function runQueries(client, {user, channel, tracks}) {
	const newUserId = v4()

	try {
		await client.query(insertAuthUser(newUserId, user))
	} catch (err) {
		throw Error(err)
	}

	// Stop if the entity doesn't have a channel.
	if (!channel) return

	let newChannelId
	try {
		const res = await client.query(insertChannel(channel))
		newChannelId = res.rows[0].id
	} catch (err) {
		console.log('could not insert channel', channel)
		throw Error(err)
	}

	try {
		await client.query(insertUserChannel(newUserId, newChannelId))
	} catch (err) {
		throw Error(err)
	}

	if (!tracks) return

	let newTracks
	try {
		const trackQueries = tracks.filter((t) => t.url).map((track) => insertTrack(track))
		const results = await Promise.all(trackQueries.map((q) => client.query(q)))
		newTracks = results.map((result) => {
			return {
				id: result.rows[0].id,
				created_at: result.rows[0].created_at,
			}
		})
	} catch (err) {
		throw Error(err)
	}

	try {
		const channelTrackQueries = newTracks.map((newTrack) =>
			insertChannelTrack(newUserId, newChannelId, newTrack.id, newTrack.created_at)
		)
		await Promise.all(channelTrackQueries.map((q) => client.query(q)))
	} catch (err) {
		throw Error(err)
	}
}

const insertAuthUser = (id, authUser) => {
	const {email, createdAt, passwordHash} = authUser
	const provider = {provider: extractProvider(authUser)}
	// @todo what about the password salt?
	return {
		text: `
			INSERT INTO auth.users(
				id,
				instance_id,
				aud,
				role,
				email,
				encrypted_password,
				email_confirmed_at,
				created_at,
				updated_at,
				last_sign_in_at,
				raw_app_meta_data,
				raw_user_meta_data,
				confirmation_token,
				recovery_token,
				email_change_token_new,
				email_change,
				is_super_admin
			)
			VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
			RETURNING id
		`,
		values: [
			id,
			'00000000-0000-0000-0000-000000000000',
			'authenticated',
			'authenticated',
			email,
			passwordHash,
			createdAt,
			createdAt,
			createdAt,
			createdAt,
			provider,
			{},
			'',
			'',
			'',
			'',
			false,
		],
	}
}

const insertChannel = (channel) => {
	const {title, slug, body, created, updated, link, image} = channel
	return {
		text: 'INSERT INTO channels(name, slug, description, created_at, updated_at, url, image) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING id',
		values: [title, slug, body, created, updated, link, image],
	}
}

const insertUserChannel = (userId, channelId) => {
	return {
		text: 'INSERT INTO user_channel(user_id, channel_id) VALUES($1, $2)',
		values: [userId, channelId],
	}
}

const insertTrack = (track) => {
	const {url, title, body, created} = track
	return {
		text: 'INSERT INTO tracks(url, title, description, created_at) VALUES($1, $2, $3, $4) RETURNING id, created_at',
		values: [url, title, body, created],
	}
}

const insertChannelTrack = (userId, channelId, trackId, createdAt) => {
	return {
		text: 'INSERT INTO channel_track(user_id, channel_id, track_id, created_at) VALUES($1, $2, $3, $4)',
		values: [userId, channelId, trackId, createdAt],
	}
}

// Supabase expects {provider: 'email/google/facebook/etc'}
function extractProvider(firebaseUser) {
	return firebaseUser.providerUserInfo.length > 0
		? firebaseUser.providerUserInfo[0].providerId.replace('.com', '')
		: 'email'
}

const delay = (ms) =>
	new Promise((resolve) => {
		setTimeout(() => {
			resolve()
		}, ms)
	})

export {migrate}
