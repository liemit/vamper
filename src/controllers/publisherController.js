exports.index = (req, res) => {
    res.render("publisher/index", { user: req.session.user });
};
