function createState() {
  const users = new Map();
  const groups = new Map();
  const groupMessages = new Map();
  const userList = () =>
    [...users].map(([socketId, name]) => ({ socketId, name }));
  const groupData = (groupId) => {
    const group = groups.get(groupId);
    return {
      groupId,
      name: group.name,
      members: [...group.members].map((socketId) => ({
        socketId,
        name: users.get(socketId),
      })),
    };
  };
  return {
    users,
    groups,
    groupMessages,
    userList,
    groupData,
    groupList: () => [...groups.keys()].map(groupData),
  };
}
module.exports = { createState };
