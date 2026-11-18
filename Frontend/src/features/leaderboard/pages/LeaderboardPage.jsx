import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Crown, Medal, Trophy } from "lucide-react";
import { api } from "../../../shared/services/api.js";
export function LeaderboardPage({ session }) {
  const token = session?.token || null;
  const isStudent = session?.user?.role === 'user';
  const cfHandle = session?.user?.profile?.codeforcesVerification?.handle || '';
  const [syncNote, setSyncNote] = useState('');
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api('/events/leaderboard').then(({
      leaderboard: results
    }) => active && setLeaderboard(results)).catch(reason => active && setError(reason.message)).finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [attempt]);
  // A signed-in student's own Codeforces count is refreshed here when it is old;
  // if it changed, the table is loaded again. A failure keeps the last stored count.
  useEffect(() => {
    if (!token || !isStudent || !cfHandle) return undefined;
    let active = true;
    setSyncNote('');
    api('/auth/codeforces/sync', { method: 'POST', token, body: JSON.stringify({ force: false }) })
      .then(result => {
        if (!active) return;
        if (result.changed) {
          session.updateUser(result.user);
          setAttempt(count => count + 1);
        } else if (!result.sync.ok && result.sync.message) setSyncNote(result.sync.message);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [token, isStudent, cfHandle]);
  const joinPrompt = !session?.user
    ? <Link className="button button-dark" to="/login">Sign in to join</Link>
    : isStudent && !cfHandle
      ? <Link className="button button-dark" to="/settings/codeforces">Add your Codeforces handle</Link>
      : null;
  return <main className="page-wrap leaderboard-page">
    <header className="leaderboard-title-card">
      <span className="leaderboard-title-icon"><Trophy size={22} aria-hidden="true" /></span>
      <div>
        <h1>Leaderboard</h1>
        <p>20 points for every problem solved on Codeforces.</p>
      </div>
    </header>
    {syncNote && <div className="notice error-notice" role="status">{syncNote}</div>}
    {!loading && leaderboard.length > 0 && isStudent && !cfHandle && <div className="notice success-notice" role="status">You are not on the leaderboard yet. <Link to="/settings/codeforces">Add your Codeforces handle</Link> to appear.</div>}
    {loading ? <div className="empty-state"><span className="loader" /> Loading the leaderboard...</div> : leaderboard.length ? <>
      <section className={`leaderboard-podium leaderboard-podium-count-${Math.min(leaderboard.length, 3)}`} aria-labelledby="leaderboard-podium-title">
        <div className="podium-heading">
          <span className="podium-heading-icon"><Trophy size={19} aria-hidden="true" /></span>
          <div>
            <h2 id="leaderboard-podium-title">Top performers</h2>
          </div>
          <span className="podium-heading-count">TOP {Math.min(leaderboard.length, 3)}</span>
        </div>
        <div className="podium-grid">
          {leaderboard.slice(0, 3).map((member, index) => {
            const place = index + 1;
            const memberContent = <>
              <span className="podium-avatar" aria-hidden="true">{member.name.trim().charAt(0).toUpperCase()}{member.avatarUrl && <img src={member.avatarUrl} alt="" loading="lazy" onError={event => event.currentTarget.remove()} />}</span>
              <span className="podium-member-name">{member.name}</span>
              <span className="podium-points"><Trophy size={15} aria-hidden="true" /> {member.points} <small>points</small></span>
              <span className="podium-stats"><span>{member.problemsSolved} solved</span><span aria-hidden="true">·</span><span>{member.eventsAttended} events</span></span>
            </>;
            const memberLink = member.username
              ? <Link className="podium-member" to={`/users/${member.username}`}>{memberContent}</Link>
              : <div className="podium-member">{memberContent}</div>;
            return <article className={`podium-place podium-place-${place}`} key={member.userId}>
              <div className="podium-card">
                <span className="podium-medal" aria-label={`Rank ${member.rank}`}>
                  {place === 1 ? <Crown size={17} aria-hidden="true" /> : <Medal size={17} aria-hidden="true" />}
                  <span>#{member.rank}</span>
                </span>
                {memberLink}
              </div>
              </article>;
          })}
        </div>
      </section>
      <section className="leaderboard-card" role="table" aria-label="Community leaderboard"><div className="leaderboard-head" role="row"><span role="columnheader">RANK</span><span role="columnheader">MEMBER</span><span role="columnheader">EVENTS</span><span role="columnheader">SOLVED</span><span role="columnheader">POINTS</span></div>
        {leaderboard.map(member => {
          const identity = <><span className="leaderboard-avatar" aria-hidden="true">{member.name.trim().charAt(0).toUpperCase()}{member.avatarUrl && <img src={member.avatarUrl} alt="" loading="lazy" onError={event => event.currentTarget.remove()} />}</span><span className="leaderboard-member-name">{member.name}</span></>;
          return <div className="leaderboard-row" key={member.userId} role="row">
            <span className="leaderboard-rank" role="cell">{String(member.rank).padStart(2, '0')}</span>
            {member.username ? <Link className="leaderboard-member-link" to={`/users/${member.username}`} role="cell">{identity}</Link> : <div className="leaderboard-member-link" role="cell">{identity}</div>}
            <span className="leaderboard-metric" role="cell">{member.eventsAttended}</span>
            <span className="leaderboard-metric" role="cell">{member.problemsSolved}</span>
            <strong role="cell"><Trophy size={16} /> {member.points}</strong>
          </div>;
        })}
      </section>
    </> : error ? <div className="notice error-notice" role="alert">{error} <button className="text-link" type="button" onClick={() => setAttempt(count => count + 1)}>Try again</button></div> : <div className="empty-state"><span className="empty-icon"><Trophy size={24} /></span><h3>No one is on the leaderboard yet.</h3><p>Add your Codeforces handle to appear here. You earn 20 points for every problem you have solved on Codeforces.</p>{joinPrompt}</div>}
  </main>;
}
